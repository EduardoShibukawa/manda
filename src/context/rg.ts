import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CORE_CAPS,
  capabilitiesToItems,
  okResult,
  unsupportedResult,
  type ContextItem,
  type ContextResult,
} from "./port";

/**
 * Provider rg + git (TASK-05): fallback do gira sem dependência além de rg e git.
 * outline/slice: regex de definição por linguagem via `rg -n`.
 * impact: `git grep -l/-n` (refs) + co-change de `git log --name-only`.
 * Mesmo schema único da porta (TASK-04); paths sempre relativos ao cwd.
 */

/** slice = linha da definição + N linhas seguintes (limitadas ao ficheiro). */
const SLICE_LINES = 12;

interface LangProfile {
  /** patterns -e passados ao rg (Rust regex). */
  rg: string[];
  /** classificador: grupos de captura (kind?, symbol); null → linha ignorada. */
  defs: Array<{ re: RegExp; kind: (m: RegExpExecArray) => string; symbol: (m: RegExpExecArray) => string }>;
}

const TS: LangProfile = {
  rg: ["^[\\s]*(export[\\s]+)?(default[\\s]+)?(declare[\\s]+)?(abstract[\\s]+)?(class|interface|enum|type|function|const|let|var)[\\s]+"],
  defs: [
    {
      re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(class|interface|enum|type|function|const|let|var)\s+([A-Za-z0-9_$]+)/,
      kind: (m) => (["const", "let", "var"].includes(m[1]) ? "variable" : m[1]),
      symbol: (m) => m[2],
    },
  ],
};

const GO: LangProfile = {
  rg: ["^[\\s]*(func|type)[\\s]+"],
  defs: [
    {
      re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)\s*\(/,
      kind: () => "function",
      symbol: (m) => m[1],
    },
    {
      re: /^\s*type\s+([A-Za-z0-9_]+)\s+/,
      kind: () => "type",
      symbol: (m) => m[1],
    },
  ],
};

const JAVA: LangProfile = {
  rg: ["^[\\s]*(?:(?:public|private|protected|static|final|abstract|sealed)[\\s]+)*(class|interface|enum|record)[\\s]+[A-Za-z0-9_]+"],
  defs: [
    {
      re: /^\s*(?:(?:public|private|protected|static|final|abstract|sealed)\s+)*(class|interface|enum|record)\s+([A-Za-z0-9_]+)/,
      kind: (m) => m[1],
      symbol: (m) => m[2],
    },
  ],
};

const PY: LangProfile = {
  rg: ["^[\\s]*(async[\\s]+)?(class|def)[\\s]+"],
  defs: [
    {
      re: /^\s*(?:async\s+)?(class|def)\s+([A-Za-z0-9_]+)/,
      kind: (m) => (m[1] === "def" ? "function" : "class"),
      symbol: (m) => m[2],
    },
  ],
};

const LANGS: Record<string, LangProfile> = {
  ".ts": TS, ".tsx": TS, ".mts": TS, ".cts": TS,
  ".js": TS, ".jsx": TS, ".mjs": TS, ".cjs": TS,
  ".go": GO,
  ".java": JAVA,
  ".py": PY,
};

function profileFor(relPath: string): LangProfile | null {
  const dot = relPath.lastIndexOf(".");
  if (dot === -1) return null;
  return LANGS[relPath.slice(dot).toLowerCase()] ?? null;
}

function run(argv: string[], cwd: string): { ok: boolean; out: string } {
  try {
    const r = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
    return { ok: (r.exitCode ?? 1) === 0, out: r.stdout.toString() };
  } catch {
    return { ok: false, out: "" };
  }
}

const stripDot = (p: string): string => (p.startsWith("./") ? p.slice(2) : p);

/** linha do rg (`path:num:conteudo`, com --no-heading -n -H) → {path,line,content} ou null. */
function parseRgLine(s: string): { path: string; line: number; content: string } | null {
  const i = s.indexOf(":");
  const j = s.indexOf(":", i + 1);
  if (i === -1 || j === -1) return null;
  const line = Number(s.slice(i + 1, j));
  if (!Number.isInteger(line) || line <= 0) return null;
  return { path: stripDot(s.slice(0, i)), line, content: s.slice(j + 1) };
}

function classify(path: string, line: number, content: string): ContextItem | null {
  const prof = profileFor(path);
  if (!prof) return null;
  for (const d of prof.defs) {
    const m = d.re.exec(content);
    if (!m) continue;
    const symbol = d.symbol(m);
    if (!symbol) continue;
    return { path, line, symbol, kind: d.kind(m), text: content.trim() };
  }
  return null;
}

/** rg -n com os patterns da linguagem sobre um path (ficheiro ou diretório relativo ao cwd). */
function rgDefs(patterns: string[], target: string, cwd: string): Array<{ path: string; line: number; content: string }> {
  const argv = ["rg", "-n", "--no-heading", "--with-filename", "--color", "never", "--sort", "path"];
  for (const p of patterns) argv.push("-e", p);
  argv.push("--", target);
  const r = run(argv, cwd);
  const items: Array<{ path: string; line: number; content: string }> = [];
  for (const s of r.out.split("\n")) {
    if (!s.trim()) continue;
    const hit = parseRgLine(s);
    if (hit) items.push(hit);
  }
  return items;
}

function outline(relPath: string, cwd: string): ContextResult {
  const path = stripDot(relPath);
  if (!existsSync(join(cwd, path))) return unsupportedResult("rg", "outline");
  const prof = profileFor(path);
  if (prof === null) return okResult("rg", "outline", []);
  const items: ContextItem[] = [];
  for (const hit of rgDefs(prof.rg, `./${path}`, cwd)) {
    const it = classify(path, hit.line, hit.content);
    if (it) items.push(it);
  }
  return okResult("rg", "outline", items);
}

function slice(symbol: string, cwd: string): ContextResult {
  const patterns: string[] = [];
  for (const prof of Object.values(LANGS)) for (const p of prof.rg) if (!patterns.includes(p)) patterns.push(p);
  const items: ContextItem[] = [];
  for (const hit of rgDefs(patterns, ".", cwd)) {
    const it = classify(hit.path, hit.line, hit.content);
    if (it === null || it.symbol !== symbol) continue;
    let lines: string[];
    try {
      lines = readFileSync(join(cwd, it.path), "utf8").split("\n");
    } catch {
      continue;
    }
    it.text = lines.slice(it.line - 1, it.line - 1 + SLICE_LINES).join("\n").trimEnd();
    items.push(it);
  }
  return okResult("rg", "slice", items);
}

/** blocos do `git log --name-only --pretty=format:%x00`: um array de paths por commit. */
function logBlocks(out: string): string[][] {
  const blocks: string[][] = [];
  for (const chunk of out.split("\0")) {
    const files = chunk
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (files.length > 0) blocks.push(files);
  }
  return blocks;
}

function impact(target: string, cwd: string): ContextResult {
  if (!run(["git", "rev-parse", "--is-inside-work-tree"], cwd).ok) return unsupportedResult("rg", "impact");

  const asPath = target.includes("/") || /\.[a-z]+$/i.test(target) || existsSync(join(cwd, target));
  const items: ContextItem[] = [];
  const seen = new Set<string>();
  const push = (it: ContextItem): void => {
    const key = `${it.path}\u0000${it.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(it);
  };

  const seeds = new Set<string>();
  if (asPath) {
    push({ path: stripDot(target), line: 1, symbol: stripDot(target), kind: "path", text: stripDot(target) });
    seeds.add(stripDot(target));
  }
  const grep = run(["git", "grep", "-n", "-w", "-F", "--", target], cwd);
  for (const s of grep.out.split("\n")) {
    if (!s.trim()) continue;
    const hit = parseRgLine(s);
    if (!hit) continue;
    seeds.add(hit.path);
    push({ path: hit.path, line: hit.line, symbol: target, kind: "ref", text: hit.content.trim() });
  }

  const log = run(["git", "log", "--name-only", "--pretty=format:%x00", "--no-color"], cwd);
  if (log.ok) {
    const co = new Set<string>();
    for (const files of logBlocks(log.out)) {
      if (!files.some((f) => seeds.has(f))) continue;
      for (const f of files) if (!seeds.has(f) && profileFor(f) !== null) co.add(f);
    }
    for (const path of [...co].sort()) {
      push({ path, line: 1, symbol: target, kind: "co-change", text: `co-change com ${[...seeds].sort().join(", ")}` });
    }
  }
  return okResult("rg", "impact", items);
}

/**
 * Adapter rg: `manda context <cap> <arg> --json` só com rg + git, no schema único da porta.
 * Extras (gira:*) e capacidades desconhecidas degradam para unsupported.
 */
export function rgContext(capability: string, arg: string | undefined, cwd: string): ContextResult {
  if (capability === "capabilities") return okResult("rg", "capabilities", capabilitiesToItems(CORE_CAPS));
  if (arg === undefined) return unsupportedResult("rg", capability);
  switch (capability) {
    case "outline":
      return outline(arg, cwd);
    case "slice":
      return slice(arg, cwd);
    case "impact":
      return impact(arg, cwd);
    default:
      return unsupportedResult("rg", capability);
  }
}
