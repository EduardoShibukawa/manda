import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

import { loadProject } from "./project";
import { resolveRuntime as defaultResolveRuntime } from "./runtime";
import type { RuntimeAdapter } from "./runtime/port";
import { topoSort } from "./bundle";

export interface PlanFromArtifactOptions {
  root?: string;
  source: string;
  resolveRuntime?: (name: string) => RuntimeAdapter;
}

export interface PlanFromArtifactResult {
  exitCode: number;
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

function splitEntry(entry: string): { provider: string; model: string } {
  const slash = entry.indexOf("/");
  if (slash === -1) return { provider: entry.trim(), model: "" };
  return { provider: entry.slice(0, slash).trim(), model: entry.slice(slash + 1).trim() };
}

function runtimeForProvider(provider: string): string {
  if (provider === "claude" || provider === "codex" || provider === "agy") return provider;
  return "pi";
}

function resolveSourcePath(root: string, source: string): string | null {
  const candidates: string[] = [];
  if (source.includes("/") || source.endsWith(".md") || isAbsolute(source)) {
    const a = isAbsolute(source) ? source : join(process.cwd(), source);
    candidates.push(a);
    if (!isAbsolute(source)) candidates.push(join(root, source));
  } else {
    for (const sub of ["intents", "specs"]) {
      const dir = join(root, ".ginga", sub);
      if (!existsSync(dir)) continue;
      const exact = join(dir, `${source}.md`);
      if (existsSync(exact)) candidates.push(exact);
      try {
        for (const f of readdirSync(dir)) {
          if (f.startsWith(source) && f.endsWith(".md")) candidates.push(join(dir, f));
        }
      } catch {}
    }
  }
  candidates.sort();
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function maxPlanNumber(root: string): number {
  const plansDir = join(root, ".ginga", "plans");
  let max = 0;
  if (existsSync(plansDir)) {
    try {
      for (const d of readdirSync(plansDir)) {
        const m = d.match(/^PLAN-(\d{4})(?:-|$)/);
        if (m) max = Math.max(max, parseInt(m[1]!, 10));
      }
    } catch {}
  }
  return max;
}

function computeSlug(sourcePath: string, sourceId: string): string {
  const stem = basename(sourcePath, extname(sourcePath));
  let slug = stem;
  if (stem.startsWith(sourceId + "-")) slug = stem.slice(sourceId.length + 1);
  if (!slug) slug = "plan";
  // keep url-safe-ish
  return slug;
}

function parseFiles(text: string): Record<string, string> {
  const files: Record<string, string> = {};
  const matches = [...text.matchAll(/^=== FILE: (.+?) ===\s*$/gm)];
  if (matches.length === 0) return files;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const name = m[1]!.trim();
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : text.length;
    let body = text.slice(start, end);
    body = body.replace(/^\r?\n/, "");
    body = body.replace(/\n+$/, "\n");
    if (body === "\n") body = "";
    files[name] = body.endsWith("\n") || body === "" ? body : body + "\n";
  }
  return files;
}

function validate(
  files: Record<string, string>,
  planId: string,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!files["PLAN.md"]) errors.push("PLAN.md ausente");
  const taskNames = Object.keys(files)
    .filter((n) => /^TASK-.+\.md$/.test(n))
    .sort();
  if (taskNames.length === 0) errors.push("nenhuma TASK-*.md");

  if (files["PLAN.md"]) {
    const fm = parseFrontmatter(files["PLAN.md"]);
    if (!("type" in fm) || fm.type === undefined || fm.type === null || fm.type === "") {
      errors.push("PLAN.md: campo type obrigatório");
    }
    if (!("title" in fm) || fm.title === undefined || fm.title === null || fm.title === "") {
      errors.push("PLAN.md: campo title obrigatório");
    }
  }

  const taskFms: Record<string, Record<string, unknown>> = {};
  for (const name of taskNames) {
    const fm = parseFrontmatter(files[name]!);
    taskFms[name] = fm;
    const lines = files[name]!.trimEnd().split(/\r?\n/).length;
    if (lines > 25) errors.push(`${name}: mais de 25 linhas`);
    for (const field of ["type", "mode", "goal", "plan", "depends_on", "tier", "touch", "done_when", "tests_frozen"]) {
      if (!(field in fm)) errors.push(`${name}: campo ${field} obrigatório`);
    }
    if ("plan" in fm && fm.plan !== planId) {
      errors.push(`${name}: plan deve ser ${planId}`);
    }
    let deps: string[] | null = null;
    if (Array.isArray(fm.depends_on)) {
      deps = (fm.depends_on as unknown[]).map((v) => String(v).trim()).filter(Boolean);
    } else if (typeof fm.depends_on === "string") {
      const s = fm.depends_on.trim();
      if (s === "" || s === "[]") deps = [];
      else errors.push(`${name}: depends_on deve ser lista`);
    } else if (!("depends_on" in fm)) {
      // handled by required check
    } else {
      errors.push(`${name}: depends_on deve ser lista`);
    }
    if (deps) {
      for (const dep of deps) {
        if (!taskNames.includes(dep.endsWith(".md") ? dep : `${dep}.md`) && !taskNames.includes(dep)) {
          // normalize: depends_on uses task id without .md
          if (!taskNames.map((n) => n.replace(/\.md$/, "")).includes(dep)) {
            errors.push(`${name}: depends_on referencia TASK inexistente (${dep})`);
          }
        }
      }
    }
  }

  // cycle detection
  if (taskNames.length > 0) {
    const tasks = taskNames.map((name) => {
      const fm = taskFms[name]!;
      let deps: string[] = [];
      if (Array.isArray(fm.depends_on)) deps = (fm.depends_on as unknown[]).map((v) => String(v).trim());
      return { task: name.replace(/\.md$/, ""), depends_on: deps } as any;
    });
    try {
      topoSort(tasks);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(msg.includes("ciclo") ? msg : `ciclo em depends_on: ${msg}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

interface GingaLintError {
  file?: unknown;
  field?: unknown;
  message?: unknown;
}

function isBlockingLintError(e: GingaLintError): boolean {
  const message = typeof e.message === "string" ? e.message : "";
  return e.field === "frontmatter" || message === "obrigatório" || message.startsWith("inválido:");
}

function runGingaLint(stagingDir: string): { ok: boolean; output: string } {
  try {
    const r = Bun.spawnSync(["ginga", "lint", stagingDir, "--json"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    if (r.exitCode === null || r.exitCode === 0) return { ok: true, output: "" };
    const stdout = r.stdout.toString();
    const raw = (stdout + (r.stderr.toString() ? "\n" + r.stderr.toString() : "")).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { ok: false, output: raw };
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { errors?: unknown }).errors)) {
      return { ok: false, output: raw };
    }
    const blocking = ((parsed as { errors: GingaLintError[] }).errors ?? []).filter(
      (e) => e && typeof e === "object" && isBlockingLintError(e),
    );
    if (blocking.length === 0) return { ok: true, output: "" };
    const output = blocking
      .map((e) => [String(e.file ?? ""), String(e.field ?? ""), String(e.message ?? "")].join(": "))
      .join("\n");
    return { ok: false, output };
  } catch {
    return { ok: true, output: "" };
  }
}

function forceDraft(content: string): string {
  if (/^status:/m.test(content)) {
    return content.replace(/^status:.*$/m, "status: draft");
  }
  const end = content.indexOf("\n---", 3);
  if (end !== -1) {
    return content.slice(0, end) + "\nstatus: draft" + content.slice(end);
  }
  return content;
}

function buildPrompt(opts: {
  planId: string;
  sourceText: string;
  sourceId: string;
  lastErrors: string[];
}): string {
  const lines: string[] = [];
  lines.push(`Você é o Planner. Gere um PLAN e TASKs para a fonte ${opts.sourceId}.`);
  lines.push(`O novo plano tem id ${opts.planId}; grave na pasta ${opts.planId}.`);
  lines.push(`Texto da fonte:\n${opts.sourceText}`);
  lines.push(`Formato: cada arquivo em bloco começando em "=== FILE: <nome> ===" (PLAN.md, TASK-*.md).`);
  lines.push(`Campos obrigatórios: PLAN.md com type, title, intent (id do INTENT de origem); cada TASK com type, mode, goal, plan (= ${opts.planId}), depends_on, tier, touch, done_when, tests_frozen.`);
  lines.push(`Os campos touch, done_when, tests_frozen, depends_on devem estar presentes. Cada TASK tem no máximo 25 linhas.`);
  lines.push(`Status do PLAN sempre draft.`);
  if (opts.lastErrors.length > 0) {
    lines.push(`Erros da tentativa anterior (corrija):\n${opts.lastErrors.join("\n")}`);
  }
  return lines.join("\n");
}

export async function planFromArtifact(
  opts: PlanFromArtifactOptions,
): Promise<PlanFromArtifactResult> {
  const root = opts.root ?? process.cwd();
  const source = opts.source;

  const sourcePath = resolveSourcePath(root, source);
  if (!sourcePath) {
    console.error(`source not found: ${source}`);
    return { exitCode: 2 };
  }
  const sourceText = readFileSync(sourcePath, "utf8");
  const sourceId = source.includes("/") || source.endsWith(".md")
    ? basename(sourcePath, extname(sourcePath))
    : source;

  const project = loadProject(root);
  const runtimes = (project.runtimes ?? {}) as Record<string, unknown>;
  let plannerSpec = typeof runtimes.planner === "string" ? (runtimes.planner as string).trim() : "";

  // Fallback: resolve Planner pelo pool do ROUTING.md quando [runtimes].planner ausente.
  if (!plannerSpec) {
    const raw = Bun.TOML.parse(readFileSync(join(root, ".ginga", "project.toml"), "utf8")) as Record<string, unknown> || {};
    const routing = (raw.routing as Record<string, unknown>) ?? {};
    const configured = typeof routing.models === "string" ? (routing.models as string).trim() : ".ginga/models";
    const modelsDir = isAbsolute(configured) ? configured : join(root, configured);
    const routingPath = join(modelsDir, "ROUTING.md");
    if (existsSync(routingPath)) {
      const fm = parseFrontmatter(readFileSync(routingPath, "utf8"));
      const pools = (fm.pools as Record<string, unknown>) ?? {};
      const plannerPool = pools.planner;
      if (Array.isArray(plannerPool) && plannerPool.length > 0) {
        const first = String(plannerPool[0]).trim();
        if (first.includes("/")) {
          const { provider } = splitEntry(first);
          const runtime = runtimeForProvider(provider);
          plannerSpec = `${runtime}:${first}`;
        } else {
          const provider = first.startsWith("claude") ? "claude"
            : first.startsWith("codex") || first.startsWith("gpt") || first.startsWith("o") ? "codex"
            : first.startsWith("gemini") ? "agy"
            : first;
          const runtime = runtimeForProvider(provider);
          plannerSpec = `${runtime}:${provider}/${first}`;
        }
      }
    }
  }

  if (!plannerSpec) {
    console.error("Configure [runtimes] em .ginga/project.toml");
    console.error("[runtimes]");
    return { exitCode: 1 };
  }

  let runtimeName: string;
  let entry: string;
  const colon = plannerSpec.indexOf(":");
  if (colon !== -1) {
    runtimeName = plannerSpec.slice(0, colon).trim();
    entry = plannerSpec.slice(colon + 1).trim();
  } else {
    entry = plannerSpec;
    runtimeName = runtimeForProvider(splitEntry(entry).provider);
  }
  const { provider, model } = splitEntry(entry);
  if (!runtimeName) runtimeName = runtimeForProvider(provider);

  const resolveRuntime = opts.resolveRuntime ?? defaultResolveRuntime;
  const adapter = resolveRuntime(runtimeName);

  const maxN = maxPlanNumber(root);
  const slug = computeSlug(sourcePath, sourceId);
  const planId = `PLAN-${String(maxN + 1).padStart(4, "0")}-${slug}`;

  const worktree = mkdtempSync(join(tmpdir(), "manda-plan-rt-"));

  let validFiles: Record<string, string> | null = null;
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = buildPrompt({ planId, sourceText, sourceId, lastErrors });
    let resultText = "";
    try {
      const res = await adapter.run({
        worktree,
        prompt,
        model,
        provider,
        role: "planner",
      });
      resultText = res.resultText ?? "";
    } catch {
      resultText = "";
    }

    const files = parseFiles(resultText);
    const v = validate(files, planId);

    let lintOk = true;
    let lintOutput = "";
    if (v.ok && Object.keys(files).length > 0) {
      const staging = mkdtempSync(join(tmpdir(), "manda-plan-stage-"));
      for (const [n, b] of Object.entries(files)) {
        writeFileSync(join(staging, n), b);
      }
      const lr = runGingaLint(staging);
      lintOk = lr.ok;
      lintOutput = lr.output;
      rmSync(staging, { recursive: true, force: true });
      if (!lintOk) {
        v.ok = false;
        v.errors.push(lintOutput || "ginga lint falhou");
      }
    }

    if (v.ok) {
      validFiles = files;
      break;
    }
    lastErrors = v.errors;
  }

  rmSync(worktree, { recursive: true, force: true });

  if (!validFiles) {
    return { exitCode: 1 };
  }

  const planDir = join(root, ".ginga", "plans", planId);
  mkdirSync(planDir, { recursive: true });
  for (const [name, body] of Object.entries(validFiles)) {
    const content = name === "PLAN.md" ? forceDraft(body) : body;
    writeFileSync(join(planDir, name), content);
  }

  return { exitCode: 0 };
}

export async function main(argv: string[]): Promise<number> {
  let source: string | undefined;
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--root") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error("Usage: manda plan <INTENT|SPEC> [--root <dir>]");
        return 2;
      }
      root = value;
      i++;
    } else if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
    } else if (arg.startsWith("-")) {
      console.error("Usage: manda plan <INTENT|SPEC> [--root <dir>]");
      return 2;
    } else if (source === undefined) {
      source = arg;
    } else {
      console.error("Usage: manda plan <INTENT|SPEC> [--root <dir>]");
      return 2;
    }
  }
  if (!source) {
    console.error("Usage: manda plan <INTENT|SPEC> [--root <dir>]");
    return 2;
  }
  const res = await planFromArtifact({ root, source });
  return res.exitCode;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
