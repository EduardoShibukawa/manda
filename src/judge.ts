import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

import { resolvePlanDir } from "./bundle";
import { loadProject } from "./project";
import { resolveRuntime as defaultResolveRuntime } from "./runtime";
import type { RuntimeAdapter } from "./runtime/port";
import { modelFamily } from "./runtime/port";

export interface JudgeOptions {
  root?: string;
  plan: string;
  base?: string;
  head?: string;
  models?: string;
  resolveRuntime?: (name: string) => RuntimeAdapter;
}

export interface JudgeResult {
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

function loadRawProject(root: string): Record<string, unknown> {
  const p = join(root, ".ginga", "project.toml");
  if (!existsSync(p)) return {};
  try {
    return Bun.TOML.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function resolveModelsDir(modelsOpt: string | undefined, root: string): string {
  if (modelsOpt) {
    if (isAbsolute(modelsOpt)) return modelsOpt;
    const fromCwd = join(process.cwd(), modelsOpt);
    if (existsSync(fromCwd)) return fromCwd;
    return join(root, modelsOpt);
  }
  const raw = loadRawProject(root);
  const routing = (raw.routing as Record<string, unknown>) ?? {};
  const configured = typeof routing.models === "string" ? routing.models.trim() : "";
  if (configured) {
    return isAbsolute(configured) ? configured : join(root, configured);
  }
  return join(process.env.HOME ?? "", ".config", "ginga", "models");
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

function splitRuntimeSpec(spec: string): { name: string; model?: string } {
  const index = spec.indexOf(":");
  if (index === -1) return { name: spec.trim() };
  const model = spec.slice(index + 1).trim();
  return { name: spec.slice(0, index).trim(), ...(model ? { model } : {}) };
}

function resolveSpec(root: string, spec: string): string | null {
  const candidates: string[] = [];
  if (isAbsolute(spec)) candidates.push(spec);
  else {
    candidates.push(join(root, spec));
    candidates.push(join(root, ".ginga", "specs", spec));
    if (!spec.endsWith(".md")) {
      candidates.push(join(root, ".ginga", "specs", `${spec}.md`));
      candidates.push(join(root, `${spec}.md`));
    }
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function parseVerdict(
  content: string,
): { ok: true; verdict: "pass" | "fail"; findings: string[] } | { ok: false } {
  const cleaned = content.replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
  const p = parsed as Record<string, unknown>;
  if (p.verdict !== "pass" && p.verdict !== "fail") return { ok: false };
  let findings: string[] = [];
  if (p.findings !== undefined) {
    if (!Array.isArray(p.findings) || !p.findings.every((f) => typeof f === "string")) return { ok: false };
    findings = p.findings as string[];
  }
  return { ok: true, verdict: p.verdict as "pass" | "fail", findings };
}

export async function judgePlan(opts: JudgeOptions): Promise<JudgeResult> {
  const root = opts.root ?? process.cwd();
  const base = opts.base ?? "main";
  const head = opts.head ?? "HEAD";
  const resolveRuntime = opts.resolveRuntime ?? defaultResolveRuntime;

  const dir = resolvePlanDir(opts.plan, { root });
  if (!dir) {
    console.error(`plan not found: ${opts.plan}`);
    return { exitCode: 2 };
  }

  const project = loadProject(root);
  const runtimes = (project.runtimes ?? {}) as Record<string, unknown>;

  const plannerSpec = typeof runtimes.planner === "string" ? (runtimes.planner as string).trim() : "";
  const plannerChoice = splitRuntimeSpec(plannerSpec);
  const plannerModel = plannerChoice.model ?? plannerChoice.name ?? "";
  const plannerFamily = modelFamily(plannerModel);

  const modelsDir = resolveModelsDir(opts.models, root);
  const routingPath = join(modelsDir, "ROUTING.md");
  let candidates: string[] = [];
  if (existsSync(routingPath)) {
    const fm = parseFrontmatter(readFileSync(routingPath, "utf8"));
    const pools = (fm.pools as Record<string, unknown>) ?? {};
    const vj = (pools.verifier_judge as Record<string, unknown>) ?? {};
    if (Array.isArray(vj.default)) candidates = vj.default.map((v) => String(v).trim());
  }

  const eventsPath = process.env.GINGA_EVENTS;
  const attempts: Record<string, unknown>[] = [];
  if (eventsPath && existsSync(eventsPath)) {
    for (const line of readFileSync(eventsPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as Record<string, unknown>;
        if (ev.kind === "attempt" && ev.plan === opts.plan) {
          const data = ev.data;
          if (data && typeof data === "object" && !Array.isArray(data)) {
            attempts.push(data as Record<string, unknown>);
          }
        }
      } catch {
        // skip invalid lines
      }
    }
  }

  const attemptFamilies = new Set(
    attempts.map((a) => (typeof a.family === "string" ? a.family : "")).filter(Boolean),
  );

  // Fail-closed: sem família do executor conhecida, não escolhe juiz.
  if (attemptFamilies.size === 0) {
    return { exitCode: 1 };
  }

  const costTotal = attempts.reduce((acc, a) => acc + (typeof a.cost_usd === "number" ? (a.cost_usd as number) : 0), 0);

  let chosen: { provider: string; model: string; runtime: string } | null = null;
  for (const entry of candidates) {
    const { provider, model } = splitEntry(entry);
    const fam = modelFamily(model);
    if (attemptFamilies.has(fam)) continue;
    if (fam === plannerFamily) continue;
    chosen = { provider, model, runtime: runtimeForProvider(provider) };
    break;
  }

  if (!chosen) {
    return { exitCode: 1 };
  }

  const tmp = mkdtempSync(join(tmpdir(), "manda-judge-"));
  try {
    writeFileSync(join(tmp, "PLAN.md"), readFileSync(join(dir, "PLAN.md"), "utf8"));

    const planText = readFileSync(join(dir, "PLAN.md"), "utf8");
    const planFm = parseFrontmatter(planText);
    const specVal = typeof planFm.spec === "string" ? (planFm.spec as string).trim() : "";
    if (specVal) {
      const sp = resolveSpec(root, specVal);
      if (sp) writeFileSync(join(tmp, "SPEC.md"), readFileSync(sp, "utf8"));
    }

    const diffRun = Bun.spawnSync(["git", "-C", root, "diff", `${base}..${head}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    writeFileSync(join(tmp, "diff.patch"), diffRun.stdout.toString());

    const receiptsCmd = (typeof project.commands.receipts === "string" && project.commands.receipts.trim())
      ? project.commands.receipts
      : "pinga queue --json";
    const receiptsRun = Bun.spawnSync(["bash", "-lc", receiptsCmd], { cwd: root, stdout: "pipe", stderr: "pipe" });
    writeFileSync(join(tmp, "receipts.json"), receiptsRun.stdout.toString());

    const metrics = { plan: opts.plan, attempts, cost_usd_total: costTotal };
    writeFileSync(join(tmp, "metrics.json"), JSON.stringify(metrics));

    const prompt =
      "Judge the plan using only the files in the current directory (SPEC.md if present, PLAN.md, diff.patch, receipts.json, metrics.json). Return only JSON {\"verdict\":\"pass\"|\"fail\",\"findings\":string[]}.";

    const adapter = resolveRuntime(chosen.runtime);
    let resultText = "";
    try {
      const runRes = await adapter.run({
        worktree: tmp,
        prompt,
        model: chosen.model,
        provider: chosen.provider,
        role: "judge",
      });
      resultText = runRes.resultText ?? "";
    } catch {
      resultText = "";
    }

    const verdict = parseVerdict(resultText);
    if (!verdict.ok) {
      return { exitCode: 1 };
    }

    const verdictPath = join(dir, "VERDICT.json");
    writeFileSync(verdictPath, JSON.stringify({ verdict: verdict.verdict, findings: verdict.findings }));

    const sealCmd = (typeof project.commands.judge_seal === "string" && project.commands.judge_seal.trim())
      ? project.commands.judge_seal.trim()
      : "pinga judge {plan} --verdict {file} --judge-model {model} --planner-model {planner}";
    let sealExit = 0;
    if (sealCmd) {
      const cmd = sealCmd
        .replaceAll("{plan}", join(dir, "PLAN.md"))
        .replaceAll("{file}", verdictPath)
        .replaceAll("{model}", chosen.model)
        .replaceAll("{planner}", plannerModel);
      const r = Bun.spawnSync(["bash", "-lc", cmd], { cwd: root, stdout: "pipe", stderr: "pipe" });
      sealExit = r.exitCode ?? 1;
    }

    if (sealExit !== 0) {
      return { exitCode: sealExit };
    }
    return { exitCode: verdict.verdict === "pass" ? 0 : 1 };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function main(argv: string[]): Promise<number> {
  let plan: string | undefined;
  let root = process.cwd();
  let base: string | undefined;
  let head: string | undefined;
  let models: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--root" || arg === "--base" || arg === "--head" || arg === "--models") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error("Usage: manda judge <PLAN> [--root <dir>] [--base <ref>] [--head <ref>] [--models <dir>]");
        return 2;
      }
      if (arg === "--root") root = value;
      else if (arg === "--base") base = value;
      else if (arg === "--head") head = value;
      else models = value;
      i += 1;
    } else if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
    } else if (arg.startsWith("--base=")) {
      base = arg.slice("--base=".length);
    } else if (arg.startsWith("--head=")) {
      head = arg.slice("--head=".length);
    } else if (arg.startsWith("--models=")) {
      models = arg.slice("--models=".length);
    } else if (arg.startsWith("-")) {
      console.error("Usage: manda judge <PLAN> [--root <dir>] [--base <ref>] [--head <ref>] [--models <dir>]");
      return 2;
    } else if (plan === undefined) {
      plan = arg;
    } else {
      console.error("Usage: manda judge <PLAN> [--root <dir>] [--base <ref>] [--head <ref>] [--models <dir>]");
      return 2;
    }
  }

  if (!plan) {
    console.error("Usage: manda judge <PLAN> [--root <dir>] [--base <ref>] [--head <ref>] [--models <dir>]");
    return 2;
  }

  const res = await judgePlan({ root, plan, base, head, models });
  return res.exitCode;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
