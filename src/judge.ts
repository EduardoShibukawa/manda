import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

import { planBranchOf, planRepos, resolvePlanDir } from "./bundle";
import { worktreeOfBranch } from "./worktree";
import { loadProject } from "./project";
import { resolveRuntime as defaultResolveRuntime } from "./runtime";
import type { RuntimeAdapter } from "./runtime/port";
import { modelFamily } from "./runtime/port";
import { checkPaidCall } from "./cost_cap";

export interface JudgeOptions {
  root?: string;
  plan: string;
  base?: string;
  head?: string;
  models?: string;
  resolveRuntime?: (name: string) => RuntimeAdapter;
  costCmd?: string[];
  nextEstimateUsd?: number;
  since?: string;
  /** Ignora o veredito já gravado para o mesmo HEAD (T906). */
  forceRejudge?: boolean;
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

  // T906: repos do PLAN com a branch `plan/NNNN` em worktree. Com eles (e sem
  // --base/--head explícitos) o diff do bundle sai de cada repo e o veredito é
  // gravado por repo em `judge/<repo>.json`, que é o que o `manda merge` lê.
  const planBranch = planBranchOf(dir);
  const targets =
    planBranch && opts.base === undefined && opts.head === undefined
      ? planRepos(dir, root)
          .map((r) => ({ ...r, wt: worktreeOfBranch(r.path, planBranch) }))
          .filter((t): t is { name: string; path: string; wt: string } => typeof t.wt === "string" && t.wt !== "")
          .map((t) => ({
            ...t,
            head: Bun.spawnSync(["git", "-C", t.wt, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim(),
          }))
      : [];
  const verdictOf = (name: string) => join(dir, "judge", `${name}.json`);

  // um veredito por HEAD: se todo repo já tem veredito do HEAD atual, reaproveita
  if (targets.length > 0 && !opts.forceRejudge && process.env.FORCE_REJUDGE !== "1") {
    const stored = targets.map((t) => {
      try {
        const j = JSON.parse(readFileSync(verdictOf(t.name), "utf8")) as { head?: unknown; judge?: { verdict?: unknown } };
        return j.head === t.head ? j.judge?.verdict : undefined;
      } catch {
        return undefined;
      }
    });
    if (stored.every((v) => v === "pass" || v === "fail")) {
      return { exitCode: stored.every((v) => v === "pass") ? 0 : 1 };
    }
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
  let firstAttemptAt: string | undefined;
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
          const ts = typeof ev.ts === "string" ? ev.ts : undefined;
          if (ts) {
            if (!firstAttemptAt || ts < firstAttemptAt) {
              firstAttemptAt = ts;
            }
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

    if (targets.length > 0) {
      const parts = targets.map((t) => {
        const d = Bun.spawnSync(["git", "-C", t.wt, "diff", "main...HEAD"], { stdout: "pipe", stderr: "pipe" });
        return `# repo: ${t.name}\n${d.stdout.toString()}`;
      });
      writeFileSync(join(tmp, "diff.patch"), parts.join("\n"));
    } else {
      const diffRun = Bun.spawnSync(["git", "-C", root, "diff", `${base}..${head}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      writeFileSync(join(tmp, "diff.patch"), diffRun.stdout.toString());
    }

    const receiptsCmd = (typeof project.commands.receipts === "string" && project.commands.receipts.trim())
      ? project.commands.receipts
      : "pinga queue --json";
    const receiptsRun = Bun.spawnSync(["bash", "-lc", receiptsCmd], { cwd: root, stdout: "pipe", stderr: "pipe" });
    writeFileSync(join(tmp, "receipts.json"), receiptsRun.stdout.toString());

    const metrics = { plan: opts.plan, attempts, cost_usd_total: costTotal };
    writeFileSync(join(tmp, "metrics.json"), JSON.stringify(metrics));

    const prompt =
      "Judge the plan using only the files in the current directory (SPEC.md if present, PLAN.md, diff.patch, receipts.json, metrics.json). Read them with your file reading tool; do not run shell commands. Return only JSON {\"verdict\":\"pass\"|\"fail\",\"findings\":string[]}.";

    const nextEstimateUsd = typeof opts.nextEstimateUsd === "number" ? opts.nextEstimateUsd : 0.15;
    const since = opts.since ?? firstAttemptAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const costCheck = checkPaidCall({
      root,
      since,
      next_estimate_usd: nextEstimateUsd,
      model: chosen.model,
      costCmd: opts.costCmd,
    });
    if (!costCheck.allow) {
      return { exitCode: 1 };
    }

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

    const transcriptPath = join(dir, "judge-transcript.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({ model: chosen.model }) + "\n");

    const sealCmd = (typeof project.commands.judge_seal === "string" && project.commands.judge_seal.trim())
      ? project.commands.judge_seal.trim()
      : "pinga judge {plan} --verdict {file} --judge-model {model} --planner-model {planner} --usage-file {transcript}";
    let sealExit = 0;
    if (sealCmd && sealCmd !== "none") {
      const cmd = sealCmd
        .replaceAll("{plan}", join(dir, "PLAN.md"))
        .replaceAll("{file}", verdictPath)
        .replaceAll("{model}", chosen.model)
        .replaceAll("{planner}", plannerModel)
      .replaceAll("{transcript}", transcriptPath);
      const r = Bun.spawnSync(["bash", "-lc", cmd], { cwd: root, stdout: "pipe", stderr: "pipe" });
      sealExit = r.exitCode ?? 1;
    }

    if (sealExit !== 0) {
      return { exitCode: sealExit };
    }

    // veredito por repo, no formato do merge: `head` + `judge.items` com
    // `regression`. O judge cego não vê o repo, então nunca marca regressão:
    // essa é a parte do gate que compara a suíte da branch com a da main.
    if (targets.length > 0) {
      mkdirSync(join(dir, "judge"), { recursive: true });
      const ok = verdict.verdict === "pass";
      const evidence = verdict.findings.length > 0 ? verdict.findings.join("; ") : "sem achados";
      for (const t of targets) {
        writeFileSync(
          verdictOf(t.name),
          JSON.stringify({
            head: t.head,
            blind: true,
            model: chosen.model,
            judge: { verdict: verdict.verdict, items: [{ ref: "PLAN", ok, regression: false, evidence }], summary: evidence },
          }),
        );
      }
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

// Re-export do port de judge-run.sh (TASK-02) para compatibilidade de import.
export {
  runJudge,
  judgeRun,
  runJudgePlan,
  judgeRunPlan,
  mandaJudge,
  insideLlmAgent,
} from "./judge_run";

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
