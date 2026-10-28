import { readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import { loadBundle, resolvePlanDir, type TaskDoc } from "./bundle";
import { emitEvent, type EventScope } from "./events";
import { runGate } from "./gate";
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
  const choice = pickRuntime(task, ctx.runtimes);
  const adapter = ctx.resolve(choice.name);
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

  // Id da worktree/branch é estável e minúsculo: `.worktrees/wt-task-01-a`.
  const worktreeId = fullId.toLowerCase();
  const worktree = await createWorktree(repoRoot, worktreeId, BASE_BRANCH);

  const request: RunRequest = {
    worktree: worktree.path,
    prompt: formatTaskPrompt(task, {
      plan: ctx.plan,
      repo: repoRoot,
      worktree: worktree.path,
    }),
    role: "executor",
  };
  if (choice.model) request.model = choice.model;

  const started = Date.now();
  let result: RunResult;
  try {
    result = await adapter.run(request);
  } catch (error) {
    // Adapter que explode é falha de infraestrutura, não da TASK.
    result = {
      passed: false,
      failure: "infra",
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  const durationMs = Date.now() - started;

  let passed = result.passed;
  let failure: FailureKind | undefined = passed ? undefined : (result.failure ?? "infra");

  if (passed) {
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
      passed = false;
      failure = "done_when";
    }
  }

  if (passed) {
    try {
      await mergeWorktreeToTrunk(repoRoot, worktreeId, BASE_BRANCH);
      await removeWorktree(repoRoot, worktreeId);
    } catch (error) {
      passed = false;
      failure = "infra";
      const message = error instanceof Error ? error.message : String(error);
      console.error(`merge falhou para ${eventTask}: ${message}`);
    }
  }

  const model = result.model ?? choice.model;
  const usage = result.usage;

  emitEvent(
    "attempt",
    {
      runtime: adapter.name,
      ...(model ? { model } : {}),
      family: adapter.family(model ?? ""),
      tier: stringField(task, "tier"),
      attempt_n: 1,
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

  emitEvent(
    "transition",
    { entity: "task", from: "running", to: passed ? "done" : "failed", by: "system", via: "cli" },
    scope,
  );

  console.log(`[${eventTask}] ${passed ? "ok" : `falhou (${failure})`} runtime=${adapter.name}`);
  return { task: eventTask, runtime: adapter.name, passed, ...(failure ? { failure } : {}) };
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

  const ctx: TaskContext = {
    root,
    plan,
    meta: planMeta(dir),
    runtimes: loadProject(root).runtimes,
    resolve: opts.resolveRuntime ?? defaultResolveRuntime,
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
}

function parseCli(argv: string[]): CliArgs | null {
  let plan: string | undefined;
  let root = process.cwd();
  let task: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--root" || arg === "--task") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return null;
      if (arg === "--root") root = value;
      else task = value;
      i += 1;
    } else if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
    } else if (arg.startsWith("--task=")) {
      task = arg.slice("--task=".length);
    } else if (arg.startsWith("-")) {
      return null;
    } else if (plan === undefined) {
      plan = arg;
    } else {
      return null;
    }
  }

  return plan ? { plan, root, ...(task ? { task } : {}) } : null;
}

/** Entry da CLI `manda run` (o `bin/manda.ts` delega para cá num subprocesso). */
export async function main(argv: string[]): Promise<number> {
  const parsed = parseCli(argv);
  if (!parsed) {
    console.error(USAGE);
    return 2;
  }
  const summary = await runPlan(parsed);
  return summary.exitCode;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
