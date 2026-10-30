import { realpathSync, lstatSync, existsSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { Glob } from "bun";

export type ResolvedPath = { ok: true; rel: string } | { ok: false; rule: "path_escape" };

function isInsideRoot(root: string, candidate: string): boolean {
  const rootNorm = normalize(resolve(root));
  const candNorm = normalize(resolve(candidate));
  if (candNorm === rootNorm) return true;
  if (candNorm.startsWith(rootNorm + sep)) return true;
  // handle case where root doesn't end with separator
  if (rootNorm === candNorm) return true;
  return candNorm.startsWith(rootNorm.endsWith(sep) ? rootNorm : rootNorm + sep);
}

export function resolvePath(root: string, p: string): ResolvedPath {
  if (typeof p !== "string") {
    return { ok: false, rule: "path_escape" };
  }

  const rootResolved = normalize(resolve(root));

  // Check for obvious escape patterns
  if (p.includes("..")) {
    // Try to resolve - if it escapes, block
  }

  // If absolute path
  if (isAbsolute(p)) {
    const absPath = normalize(resolve(p));
    if (!isInsideRoot(rootResolved, absPath)) {
      return { ok: false, rule: "path_escape" };
    }
    // It's inside root, make relative
    let rel = relative(rootResolved, absPath);
    if (rel === "") rel = ".";
    // normalize
    rel = normalize(rel).replace(/\\/g, "/");
    // but if empty string becomes something weird, handle
    if (rel === ".") return { ok: false, rule: "path_escape" }; // probably not the case for files
    // But test says join(root, "src/a.ts") should return rel "src/a.ts"
    if (rel.startsWith("..")) return { ok: false, rule: "path_escape" };
    return { ok: true, rel: rel.split("/").filter(s => s !== ".").join("/") || rel };
  }

  // For relative paths, resolve against root
  const joined = resolve(rootResolved, p);
  const normalized = normalize(joined);

  // Check if it escapes root
  if (normalized.startsWith("..") || !isInsideRoot(rootResolved, normalized)) {
    // More precise check
    if (!isInsideRoot(rootResolved, normalized)) {
      return { ok: false, rule: "path_escape" };
    }
  }

  // Check for symlink escape
  try {
    // Try to resolve symlinks
    const parts = p.replace(/\\/g, "/").split("/").filter(s => s !== "" && s !== ".");
    let currentPath = rootResolved;
    for (let i = 0; i < parts.length; i++) {
      currentPath = resolve(currentPath, parts[i]);
      try {
        const lst = lstatSync(currentPath);
        if (lst.isSymbolicLink()) {
          try {
            const real = realpathSync(currentPath);
            if (!isInsideRoot(rootResolved, real)) {
              return { ok: false, rule: "path_escape" };
            }
          } catch {
            // if can't resolve, be careful
          }
        }
      } catch {
        // If it doesn't exist, check parent
        if (i < parts.length - 1) {
          // going into non-existent dir is odd, but check what exists
        }
        break; // file doesn't exist, check parent
      }
    }
    // If the final path or any symlink along the way points outside
    // Also check: for non-existent files, resolve parent dir via realpath
    if (parts.length > 0) {
      // check all existing components
      let checkPath = rootResolved;
      for (let i = 0; i < parts.length; i++) {
        const nextPath = resolve(checkPath, parts[i]);
        try {
          const lst = lstatSync(nextPath);
          if (lst.isSymbolicLink()) {
            const real = realpathSync(nextPath);
            if (!isInsideRoot(rootResolved, real)) {
              return { ok: false, rule: "path_escape" };
            }
            checkPath = real;
          } else {
            checkPath = nextPath;
          }
        } catch {
          // doesn't exist - if it's not the last component, maybe problematic
          // but check parent realpath
          if (i === parts.length - 1) {
            // last component doesn't exist, check parent
            try {
              const parentReal = realpathSync(checkPath);
              if (!isInsideRoot(rootResolved, parentReal)) {
                return { ok: false, rule: "path_escape" };
              }
            } catch {
              // parent also might not exist fully, but test says "arquivo inexistente com pai real dentro → ok" if parent dir exists
            }
          } else {
            break;
          }
        }
      }
    }
  } catch (e) {
    // ignore
  }

  // Compute relative path from root
  let rel = relative(rootResolved, normalized);
  rel = normalize(rel).replace(/\\/g, "/");
  // Clean up ./
  if (rel.startsWith("./")) rel = rel.slice(2);
  if (rel === "." || rel === "") {
    // might be the root itself
    return { ok: false, rule: "path_escape" };
  }
  if (rel.split("/").some(part => part === "..")) {
    return { ok: false, rule: "path_escape" };
  }
  if (rel.startsWith("../")) {
    return { ok: false, rule: "path_escape" };
  }
  return { ok: true, rel: rel };
}

export function matchesAny(rel: string, patterns: string[]): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const normalizedRel = rel.replace(/\\/g, "/");
  
  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    const pat = pattern.replace(/\\/g, "/");
    
    // Pattern ending in / means directory prefix
    if (pat.endsWith("/")) {
      const base = pat.slice(0, -1);
      if (normalizedRel === base) return true;
      if (normalizedRel.startsWith(base + "/")) return true;
      continue;
    }
    
    // Check for globs
    if (pat.includes("*")) {
      try {
        const glob = new Glob(pat);
        if (glob.match(normalizedRel)) {
          return true;
        }
      } catch {
        // fallback
      }
      continue;
    }
    
    // Exact match
    if (normalizedRel === pat) {
      return true;
    }
  }
  return false;
}
