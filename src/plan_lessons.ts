// PLAN-0013 TASK-07: lições (LESSON-*.md) encontradas pelo touch das TASKs.
// Fonte preferida: `ginga lessons find --touch <csv> --json` (cwd = root).
// Fallback (sem `ginga` no PATH): varre `.ginga/knowledge/lessons/` replicando
// o mesmo match de scope.files do ginga (prefixo "dir/" ou glob com * e ?),
// para dar o mesmo resultado nos dois modos. Sem importar código do ginga.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { projectCommand, runProjectCommand } from "./project";
import { join } from "node:path";

export interface LessonRef {
  id: string;
  title: string;
  path: string;
}

interface LessonFile {
  id: string;
  title: string;
  path: string;
  files: string[];
}

function globMatch(pattern: string, str: string): boolean {
  if (pattern.endsWith("/")) {
    const prefix = pattern.slice(0, -1);
    return str.startsWith(prefix + "/") || str === prefix;
  }
  const regexStr = "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(regexStr).test(str);
}

function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const yaml = text.slice(3, end).trim();
  if (!yaml) return {};
  try {
    const parsed = Bun.YAML.parse(yaml);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readLessonFiles(root: string): LessonFile[] {
  const lessonsDir = join(root, ".ginga", "knowledge", "lessons");
  if (!existsSync(lessonsDir)) return [];
  const out: LessonFile[] = [];
  for (const f of readdirSync(lessonsDir).filter((n) => /^LESSON-\d+.*\.md$/.test(n)).sort()) {
    const content = readFileSync(join(lessonsDir, f), "utf8");
    if (!content.startsWith("---")) continue;
    const fm = parseFrontmatter(content);
    const scope = (fm.scope ?? {}) as Record<string, unknown>;
    const files = Array.isArray(scope.files) ? scope.files.map((v) => String(v)) : [];
    const idMatch = f.match(/^LESSON-\d+/);
    out.push({
      id: idMatch ? idMatch[0] : f.replace(/\.md$/, ""),
      title: typeof fm.title === "string" ? fm.title : "",
      path: join("knowledge", "lessons", f),
      files,
    });
  }
  return out;
}

function fallbackFind(root: string, touch: string[]): LessonRef[] {
  const result: LessonRef[] = [];
  for (const lesson of readLessonFiles(root)) {
    for (const pattern of lesson.files) {
      if (touch.some((fp) => globMatch(pattern, fp))) {
        result.push({ id: lesson.id, title: lesson.title, path: lesson.path });
        break;
      }
    }
  }
  return result;
}

/** Padrão de `[commands].lessons` (T903). */
export const DEFAULT_LESSONS = "ginga lessons find --touch {touch} --json";

function gingaFind(root: string, touch: string[]): LessonRef[] | null {
  const cmd = projectCommand(root, "lessons", DEFAULT_LESSONS);
  if (cmd === null) return null; // "none": só a varredura dos arquivos
  let r: { exitCode: number | null; stdout: { toString(): string } };
  try {
    const out = runProjectCommand(cmd, { touch: touch.join(",") }, root);
    r = { exitCode: out.code, stdout: { toString: () => out.stdout } };
  } catch {
    return null; // comando não resolve
  }
  if (r.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout.toString()) as { lessons?: unknown };
    if (!parsed || !Array.isArray(parsed.lessons)) return null;
    return parsed.lessons.map((l) => {
      const o = l as Record<string, unknown>;
      return { id: String(o.id ?? ""), title: String(o.title ?? ""), path: String(o.path ?? "") };
    });
  } catch {
    return null;
  }
}

export function lessonsForTouch(root: string, touch: string[]): LessonRef[] {
  const paths = touch.map((t) => t.trim()).filter(Boolean);
  if (paths.length === 0) return [];
  return gingaFind(root, paths) ?? fallbackFind(root, paths);
}
