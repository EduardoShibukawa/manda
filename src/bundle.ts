import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";

export interface TaskDoc extends Record<string, unknown> {
  task: string;
  depends_on: string[];
}

export interface PlanBundleJson {
  schema_version: number;
  tasks: TaskDoc[];
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve the argument of `plan show` (dir, PLAN.md path or plan id) to a
 *  directory that contains PLAN.md, or null when it does not exist. */
export function resolvePlanDir(arg: string, opts: { root?: string } = {}): string | null {
  const abs = (p: string) => (isAbsolute(p) ? p : join(opts.root ?? process.cwd(), p));
  if (arg.startsWith("/") || arg.startsWith("./") || arg.startsWith("../")) {
    const a = abs(arg);
    if (isDir(a)) return existsSync(join(a, "PLAN.md")) ? a : null;
    const f = a.endsWith(".md") ? a : join(a, "PLAN.md");
    return existsSync(f) ? dirname(f) : null;
  }
  const root = opts.root ?? process.cwd();
  const direct = join(root, arg);
  if (isDir(direct) && existsSync(join(direct, "PLAN.md"))) return direct;
  if (arg.endsWith(".md") && existsSync(direct)) return dirname(direct);
  const plansDir = join(root, ".ginga", "plans");
  if (existsSync(plansDir)) {
    const exact = join(plansDir, arg);
    if (existsSync(join(exact, "PLAN.md"))) return exact;
    const candidates = readdirSync(plansDir)
      .filter((d) => (d === arg || d.startsWith(arg + "-")) && existsSync(join(plansDir, d, "PLAN.md")))
      .sort();
    if (candidates.length > 0) return join(plansDir, candidates[0]);
  }
  return null;
}

/** Read the bundle (frontmatter of the PLAN and of the TASK-*.md files)
 *  without validating the whole thing, in topological order of depends_on. */
export function loadBundle(dir: string): PlanBundleJson {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("TASK-") && extname(f) === ".md")
    .sort();
  const tasks: TaskDoc[] = [];
  for (const f of files) {
    const fm = parseFrontmatter(readFileSync(join(dir, f), "utf8"));
    const id = f.slice(0, -extname(f).length);
    const t = { ...fm, task: id } as TaskDoc;
    t.depends_on = Array.isArray(fm.depends_on) ? (fm.depends_on as string[]).map(String) : [];
    tasks.push(t);
  }
  return { schema_version: 1, tasks: topoSort(tasks) };
}

export function topoSort(tasks: TaskDoc[]): TaskDoc[] {
  const byId = new Map(tasks.map((t) => [t.task, t]));
  const state = new Map<string, 0 | 1 | 2>();
  const out: TaskDoc[] = [];
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    const s = state.get(id);
    if (s === 2) return null;
    if (s === 1) return [...stack.slice(stack.indexOf(id)), id];
    const t = byId.get(id);
    if (!t) return null;
    state.set(id, 1);
    stack.push(id);
    for (const dep of t.depends_on ?? []) {
      const c = byId.has(dep) ? visit(dep) : null;
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    out.push(t);
    return null;
  };
  for (const t of tasks) {
    if (state.get(t.task) !== 2) {
      stack.length = 0;
      const cycle = visit(t.task);
      if (cycle) throw new CycleError(cycle);
    }
  }
  return out;
}

export class CycleError extends Error {
  cycle: string[];
  constructor(cycle: string[]) {
    super(`ciclo em depends_on: ${cycle.join(" -> ")}`);
    this.name = "CycleError";
    this.cycle = cycle;
  }
}

function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const yaml = text.slice(3, end).trim();
  if (!yaml) return {};
  const parsed = Bun.YAML.parse(yaml);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}


/** Branch do PLAN (`plan/NNNN`) a partir do nome do dir/ID, ou null. */
export function planBranchOf(plan: string): string | null {
  const n = basename(plan).match(/PLAN-(\d{4})/)?.[1];
  return n ? `plan/${n}` : null;
}

/**
 * Repos de um PLAN (T906): os `repo:` distintos das TASKs, como subpastas da
 * raiz do workspace. PLAN sem `repo:` em nenhuma TASK vale a própria raiz.
 */
export function planRepos(dir: string, root: string): { name: string; path: string }[] {
  const names: string[] = [];
  for (const t of loadBundle(dir).tasks) {
    const r = typeof (t as Record<string, unknown>).repo === "string" ? String((t as Record<string, unknown>).repo).trim() : "";
    if (r && !names.includes(r)) names.push(r);
  }
  if (names.length === 0) return [{ name: basename(root), path: root }];
  return names.map((name) => ({ name: isAbsolute(name) ? basename(name) : name, path: isAbsolute(name) ? name : join(root, name) }));
}
