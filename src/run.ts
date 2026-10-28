import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import { loadBundle, resolvePlanDir, type TaskDoc } from "./bundle";
import { emitEvent, type EventScope } from "./events";
import { appendSpend, computeSpendFromJsonl, loadAskOwner, loadBudgetConfig, runSpendCmd } from "./budget";
import { buildAttemptPlan, getBreaker, hasFixedRuntime, loadEscalation } from "./escalation";import { runGate } from "./gate";
import { loadProject } from "./project";
import { resolveRuntime as defaultResolveRuntime } from "./runtime";
import type { FailureKind, RunRequest, RunResult, RuntimeAdapter } from "./runtime/port";
import { createWorktree, mergeWorktreeToTrunk, removeWorktree } from "./worktree";

/**
 * `manda run <PLAN> [--task T]`: para cada TASK, na ordem do DAG, cria a
 * worktree, sobe o executor no runtime da TASK, roda o gate e faz o merge.
 * Cada TASK vira um `attempt` e duas `transition` em `$GINGA_EVENTS`.
 *
 * Fora do escopo (PLAN-0008): escalada, budget e judge. Claim/lease é do
 * `ginga tick`, não do manda.
 */

const BASE_BRANCH = "main";

/** O teste injeta um adapter; a CLI usa o resolver real. */
export type ResolveRuntime = (name: string) => RuntimeAdapter;

export interface RunOptions {
  root: string;
  plan: string;
  /** Roda só esta TASK (id completo ou `TASK-NN`). */
  task?: string;
  resolveRuntime?: ResolveRuntime;
  spendCmd?: string;
  approve?: string | string[];
}

export interface TaskOutcome {
  task: string;
  runtime: string;
  passed: boolean;
  failure?: FailureKind;
}

export interface RunSummary {
  exitCode: number;
  plan: string;
  results: TaskOutcome[];
}

interface PlanMeta {
  intent?: string;
  spec?: string;
}

interface TaskContext {
  root: string;
  plan: string;
  meta: PlanMeta;
  runtimes: Record<string, unknown>;
  resolve: ResolveRuntime;
  spendCmd?: string;
  approved: Set<string>;
}

interface RuntimeChoice {
  name: string;
  model?: string;
}

interface PromptContext {
  plan: string;
  repo: string;
  worktree: string;
}

function stringField(task: TaskDoc, name: string): string {
  const raw = task[name];
  return typeof raw === "string" ? raw.trim() : "";
}

function listField(task: TaskDoc, name: string): string[] {
  const raw = task[name];
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

/** `TASK-01-a` → `TASK-01`: o id que agrega eventos e o `{task}` do gate. */
export function shortTaskId(taskId: string): string {
  const match = taskId.match(/^(TASK-\d+)/i);
  return match ? match[1]!.toUpperCase() : taskId;
}

function matchesTask(taskId: string, wanted: string): boolean {
  return taskId === wanted || shortTaskId(taskId) === wanted.toUpperCase();
}

/** Id do PLAN como o usuário escreveu; caminho vira o nome do diretório. */
function planId(arg: string, dir: string): string {
  return arg.includes("/") || arg.endsWith(".md") ? basename(dir) : arg;
}

function planMeta(dir: string): PlanMeta {
  try {
    const text = readFileSync(join(dir, "PLAN.md"), "utf8");
    const pick = (key: string) => text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
    return { intent: pick("intent"), spec: pick("spec") };
  } catch {
    return {};
  }
}

/** `runtime` ou `runtime:modelo` (ex.: `claude:cheap-model`). */
function splitRuntimeSpec(spec: string): RuntimeChoice {
  const index = spec.indexOf(":");
  if (index === -1) return { name: spec.trim() };
  const model = spec.slice(index + 1).trim();
  return { name: spec.slice(0, index).trim(), ...(model ? { model } : {}) };
}

/**
 * Runtime da TASK: `[runtimes].executor`, senão o mapa
 * `[runtimes.tier]` pelo `tier`, senão `pi`.
 */
export function pickRuntime(task: TaskDoc, runtimes: Record<string, unknown>): RuntimeChoice {
  const executor = typeof runtimes.executor === "string" ? runtimes.executor.trim() : "";
  if (executor) return splitRuntimeSpec(executor);

  const tier = stringField(task, "tier");
  const map = runtimes.tier;
  if (tier && map && typeof map === "object") {
    const byTier = (map as Record<string, unknown>)[tier];
    if (typeof byTier === "string" && byTier.trim()) return splitRuntimeSpec(byTier);
  }
  return { name: "pi" };
}

/** Colapsa qualquer quebra de linha/espaço repetido: prompt é um argv só. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Prompt do executor: TASK (goal, tier, depends_on) + `touch` + `done_when`
 * + `tests_frozen`. Mesma diretriz cirúrgica de `formatWorkerPrompt`
 * (`pi-harness/.pi/extensions/sdlc.ts`), sem o briefing do Gira (PLAN-0009).
 *
 * Uma linha só: a CLI passa o prompt como argumento (`-p <prompt>`), e
 * quebras de linha vazam para logs/`$*` de quem ecoa a invocação.
 */
export function formatTaskPrompt(task: TaskDoc, ctx: PromptContext): string {
  const id = String(task.task);
  const goal = stringField(task, "goal");
  const tier = stringField(task, "tier");
  const deps = listField(task, "depends_on");
  const touch = listField(task, "touch");
  const doneWhen = stringField(task, "done_when");
  const frozen = listField(task, "tests_frozen");

  const head = [
    "IMPLEMENTE diretamente esta tarefa atômica no projeto.",
    "DIRETRIZ CIRÚRGICA: vá direto para a escrita/edição dos arquivos do `touch` com 'write'/'edit'. Não perca tempo explorando o diretório.",
    "CONTRATO: o `done_when` é o juiz fixo. Não edite testes congelados nem troque o comando de verificação.",
  ].join(" ");

  const body = [
    `TASK ${id}${goal ? ` — ${goal}` : ""}`,
    `plan: ${ctx.plan}`,
    `repo: ${ctx.repo}`,
    `worktree: ${ctx.worktree}`,
    ...(tier ? [`tier: ${tier}`] : []),
    ...(deps.length ? [`depends_on: ${deps.join(", ")}`] : []),
    `touch (só estes caminhos): ${touch.length ? touch.join(", ") : "(nenhum declarado)"}`,
    `done_when: ${doneWhen || "(nenhum declarado)"}`,
    ...(frozen.length ? [`tests_frozen (não toque): ${frozen.join(", ")}`] : []),
  ].join(" | ");

  return oneLine(`${head} ${body} Crie ou edite agora os arquivos do \`touch\` para satisfazer o \`done_when\` de ${id}.`);
}

function repoOf(task: TaskDoc, root: string): string {
  const repo = stringField(task, "repo");
  if (!repo) return root;
  return isAbsolute(repo) ? repo : join(root, repo);
}

async function runTask(task: TaskDoc, ctx: TaskContext): Promise<TaskOutcome> {
  const fullId = String(task.task);
  const eventTask = shortTaskId(fullId);
  const repoRoot = repoOf(task, ctx.root);
  const tier = stringField(task, "tier");
  const fixed = hasFixedRuntime(ctx.root, tier);
  const escalation = fixed ? null : loadEscalation(ctx.root);
  const choice = pickRuntime(task, ctx.runtimes);

  const scope: EventScope = {
    repo: basename(repoRoot),
    plan: ctx.plan,
    task: eventTask,
    ...ctx.meta,
  };

  emitEvent(
    "transition",
    { entity: "task", from: "pending", to: "running", by: "system", via: "cli" },
    scope,
  );

  const worktreeId = fullId.toLowerCase();
  const worktree = await createWorktree(repoRoot, worktreeId, BASE_BRANCH);

  type AttemptSpec = { tier: string; entry: string; provider: string; model: string; runtime: string };
  let builtSpecs: AttemptSpec[] = [];
  if (!fixed && escalation) {
    builtSpecs = buildAttemptPlan(ctx.root, tier || "free") as AttemptSpec[];
  }
  const useLadder = builtSpecs.length > 0;
  const attemptSpecs: AttemptSpec[] =
    builtSpecs.length > 0
      ? builtSpecs
      : [{ tier: tier || "free", entry: "", provider: choice.name, model: choice.model && choice.model.trim() ? choice.model : (choice.name === "pi" ? "pi" : ""), runtime: choice.name }];

  const breaker = useLadder ? getBreaker(ctx.root) : { same_reason: 3, ignore: [] };
  const ignore = new Set((breaker.ignore ?? []).map((v: any) => String(v)));

  let passed = false;
  let failure: FailureKind | undefined;
  let lastAdapterName = attemptSpecs[0]!.runtime;
  let lastFailure: FailureKind | undefined;
  let breakerTripped = false;
  let streakFailure: FailureKind | undefined;
  let streakCount = 0;
  let attemptNo = 0;

  for (const spec of attemptSpecs) {
    attemptNo += 1;
    lastAdapterName = spec.runtime;

    // Budget check antes de cada tentativa.
    const spent = ctx.spendCmd
      ? runSpendCmd(ctx.spendCmd, ctx.plan, eventTask)
      : computeSpendFromJsonl(ctx.root, ctx.plan, eventTask);
    const budgetCfg = loadBudgetConfig(ctx.root);
    const askOwner = loadAskOwner(ctx.root);

    const scopes = [
      { scope: "task", spent: spent.task, cap: budgetCfg.task_usd },
      { scope: "plan", spent: spent.plan, cap: budgetCfg.plan_usd },
      { scope: "month", spent: spent.month, cap: budgetCfg.month_usd },
    ];

    let blockedScope: string | null = null;
    for (const sc of scopes) {
      if (!Number.isFinite(sc.cap)) continue;
      if (ctx.approved.has(sc.scope)) continue;
      if (sc.spent >= sc.cap) {
        blockedScope = sc.scope;
        emitEvent("budget", { level: "cap", scope: sc.scope, cap_usd: sc.cap, spent_usd: sc.spent }, scope);
        break;
      }
    }
    if (!blockedScope) {
      for (const sc of scopes) {
        if (!Number.isFinite(sc.cap)) continue;
        if (ctx.approved.has(sc.scope)) continue;
        const warnAt = (budgetCfg.warn_pct / 100) * sc.cap;
        if (sc.spent >= warnAt && sc.spent < sc.cap) {
          emitEvent("budget", { level: "warn", scope: sc.scope, cap_usd: sc.cap, spent_usd: sc.spent }, scope);
        }
      }
    }

    if (blockedScope) {
      try {
        await removeWorktree(repoRoot, worktreeId);
      } catch {}
      emitEvent("transition", { entity: "task", from: "running", to: "blocked", by: "system", via: "cli" }, scope);
      emitEvent("blocker", { raised_by: "manda", blocker_id: randomUUID(), question: `TASK ${eventTask} bloqueada por teto de budget (${blockedScope})`, options: ["retry", "skip", "abort"], scope: blockedScope }, scope);
      console.log(`[${eventTask}] blocked runtime=${lastAdapterName}`);
      return { task: eventTask, runtime: lastAdapterName, passed: false, ...(lastFailure ? { failure: lastFailure } : {}) };
    }

    // OK do dono para runtime claude.
    if (spec.runtime === "claude" && !ctx.approved.has("runtime_claude") && askOwner.includes("runtime_claude")) {
      try {
        await removeWorktree(repoRoot, worktreeId);
      } catch {}
      emitEvent("transition", { entity: "task", from: "running", to: "blocked", by: "system", via: "cli" }, scope);
      emitEvent("blocker", { raised_by: "manda", blocker_id: randomUUID(), question: `TASK ${eventTask} requer OK para runtime claude`, options: ["retry", "skip", "abort"], scope: "runtime_claude" }, scope);
      console.log(`[${eventTask}] blocked runtime=${lastAdapterName}`);
      return { task: eventTask, runtime: lastAdapterName, passed: false, ...(lastFailure ? { failure: lastFailure } : {}) };
    }

    const adapter = ctx.resolve(spec.runtime);
    lastAdapterName = adapter.name;

    const request: RunRequest = {
      worktree: worktree.path,
      prompt: formatTaskPrompt(task, {
        plan: ctx.plan,
        repo: repoRoot,
        worktree: worktree.path,
      }),
      role: "executor",
    };
    if (spec.model) request.model = spec.model;
    if (spec.provider) request.provider = spec.provider;

    const started = Date.now();
    let result: RunResult;
    try {
      result = await adapter.run(request);
    } catch (error) {
      result = {
        passed: false,
        failure: "infra",
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
    const durationMs = Date.now() - started;

    let attemptPassed = result.passed;
    let attemptFailure: FailureKind | undefined = attemptPassed ? undefined : (result.failure ?? "infra");

    if (attemptPassed) {
      const gate = await runGate({
        task: `${ctx.plan}/${eventTask}`,
        plan: ctx.plan,
        repo: repoRoot,
        worktree: worktree.path,
        doneWhen: stringField(task, "done_when"),
        base: BASE_BRANCH,
        testsFrozen: listField(task, "tests_frozen"),
      });
      if (!gate.passed) {
        attemptPassed = false;
        attemptFailure = "done_when";
      }
    }

    if (attemptPassed) {
      try {
        await mergeWorktreeToTrunk(repoRoot, worktreeId, BASE_BRANCH);
        await removeWorktree(repoRoot, worktreeId);
      } catch (error) {
        attemptPassed = false;
        attemptFailure = "infra";
        const message = error instanceof Error ? error.message : String(error);
        console.error(`merge falhou para ${eventTask}: ${message}`);
      }
    }

    passed = attemptPassed;
    failure = attemptFailure;
    lastFailure = attemptFailure;

    const model = result.model ?? (spec.model || undefined);
    const usage = result.usage;

    appendSpend(ctx.root, {
      ts: new Date().toISOString(),
      plan: ctx.plan,
      task: eventTask,
      cost_usd: result.costUsd ?? 0,
      cost_source: result.costUsd === undefined ? "unknown" : "metered",
    });

    emitEvent(
      "attempt",
      {
        runtime: adapter.name,
        ...(model ? { model } : {}),
        family: adapter.family(model ?? ""),
        tier: spec.tier,
        attempt_n: attemptNo,
        passed,
        ...(failure ? { failure } : {}),
        duration_ms: durationMs,
        tokens_in: usage?.inputTokens ?? 0,
        tokens_out: usage?.outputTokens ?? 0,
        cost_usd: result.costUsd ?? 0,
        cost_source: result.costUsd === undefined ? "unknown" : "metered",
      },
      scope,
    );

    if (passed) {
      emitEvent(
        "transition",
        { entity: "task", from: "running", to: "done", by: "system", via: "cli" },
        scope,
      );
      console.log(`[${eventTask}] ok runtime=${adapter.name}`);
      return { task: eventTask, runtime: adapter.name, passed: true };
    }

    const f = attemptFailure as FailureKind;
    if (ignore.has(f)) {
      streakFailure = undefined;
      streakCount = 0;
    } else {
      if (f === streakFailure) streakCount += 1;
      else {
        streakFailure = f;
        streakCount = 1;
      }
      if (streakCount >= (breaker.same_reason ?? 3)) {
        breakerTripped = true;
      }
    }

    if (breakerTripped) break;
  }

  if (useLadder || breakerTripped) {
    emitEvent(
      "transition",
      { entity: "task", from: "running", to: "blocked", by: "system", via: "cli" },
      scope,
    );
    if (!ctx.approved.has("task")) {
      emitEvent(
        "blocker",
        {
          raised_by: "manda",
          blocker_id: randomUUID(),
          question: `TASK ${eventTask} bloqueada após ${attemptNo} tentativa(s)`,
          options: ["retry", "skip", "abort"],
          scope: "task",
        },
        scope,
      );
    }
    console.log(`[${eventTask}] blocked runtime=${lastAdapterName}`);
    return { task: eventTask, runtime: lastAdapterName, passed: false, ...(lastFailure ? { failure: lastFailure } : {}) };
  }

  emitEvent(
    "transition",
    { entity: "task", from: "running", to: "failed", by: "system", via: "cli" },
    scope,
  );
  console.log(`[${eventTask}] falhou (${failure}) runtime=${lastAdapterName}`);
  return { task: eventTask, runtime: lastAdapterName, passed: false, ...(failure ? { failure } : {}) };
}

/**
 * Executa o PLAN. Exit 0 com todas as TASKs ok, 1 quando alguma falha
 * (para na primeira: dependentes não rodam) e 2 para uso/PLAN inexistente.
 */
export async function runPlan(opts: RunOptions): Promise<RunSummary> {
  const root = opts.root || process.cwd();
  const dir = resolvePlanDir(opts.plan, { root });
  if (!dir) {
    console.error(`plan não encontrado: ${opts.plan}`);
    return { exitCode: 2, plan: opts.plan, results: [] };
  }

  const plan = planId(opts.plan, dir);
  const bundle = loadBundle(dir);
  const wanted = opts.task;
  const tasks = wanted ? bundle.tasks.filter((task) => matchesTask(task.task, wanted)) : bundle.tasks;
  if (wanted && tasks.length === 0) {
    console.error(`task não encontrada em ${plan}: ${wanted}`);
    return { exitCode: 2, plan, results: [] };
  }

  const approved = new Set<string>();
  const approveRaw = opts.approve;
  const approveList = Array.isArray(approveRaw)
    ? approveRaw
    : typeof approveRaw === "string"
      ? approveRaw.split(",")
      : [];
  for (const s of approveList) {
    const t = String(s).trim();
    if (t) approved.add(t);
  }
  const envApproved = process.env.MANDA_APPROVED_SCOPES;
  if (envApproved) {
    for (const s of envApproved.split(",")) {
      const t = s.trim();
      if (t) approved.add(t);
    }
  }

  const ctx: TaskContext = {
    root,
    plan,
    meta: planMeta(dir),
    runtimes: loadProject(root).runtimes,
    resolve: opts.resolveRuntime ?? defaultResolveRuntime,
    spendCmd: opts.spendCmd,
    approved,
  };

  const results: TaskOutcome[] = [];
  for (const task of tasks) {
    const outcome = await runTask(task, ctx);
    results.push(outcome);
    if (!outcome.passed) break;
  }

  const ok = results.filter((r) => r.passed).length;
  console.log(`${plan}: ${ok}/${results.length} TASK(s) ok`);
  return {
    exitCode: results.some((r) => !r.passed) ? 1 : 0,
    plan,
    results,
  };
}

const USAGE = "Usage: manda run <PLAN> [--task <TASK>] [--root <dir>]";

interface CliArgs {
  plan: string;
  root: string;
  task?: string;
  approve?: string;
  spendCmd?: string;
}

function parseCli(argv: string[]): CliArgs | null {
  let plan: string | undefined;
  let root = process.cwd();
  let task: string | undefined;
  let approve: string | undefined;
  let spendCmd: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--root" || arg === "--task" || arg === "--approve" || arg === "--spend-cmd") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return null;
      if (arg === "--root") root = value;
      else if (arg === "--task") task = value;
      else if (arg === "--approve") approve = value;
      else spendCmd = value;
      i += 1;
    } else if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
    } else if (arg.startsWith("--task=")) {
      task = arg.slice("--task=".length);
    } else if (arg.startsWith("--approve=")) {
      approve = arg.slice("--approve=".length);
    } else if (arg.startsWith("--spend-cmd=")) {
      spendCmd = arg.slice("--spend-cmd=".length);
    } else if (arg.startsWith("-")) {
      return null;
    } else if (plan === undefined) {
      plan = arg;
    } else {
      return null;
    }
  }

  return plan ? { plan, root, ...(task ? { task } : {}), ...(approve ? { approve } : {}), ...(spendCmd ? { spendCmd } : {}) } : null;
}

/** Entry da CLI `manda run` (o `bin/manda.ts` delega para cá num subprocesso). */
export async function main(argv: string[]): Promise<number> {
  const parsed = parseCli(argv);
  if (!parsed) {
    console.error(USAGE);
    return 2;
  }
  const summary = await runPlan({
    root: parsed.root,
    plan: parsed.plan,
    task: parsed.task,
    approve: parsed.approve,
    spendCmd: parsed.spendCmd,
  });
  return summary.exitCode;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
