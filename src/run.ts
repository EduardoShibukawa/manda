import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import { openStateDb, planNextAfterFailure, watchAttempt } from "./attempt_watch";
import { loadBundle, resolvePlanDir, type TaskDoc } from "./bundle";
import { breakerOf, recordSuccess } from "./breaker";
import { emitEvent, type EventScope } from "./events";
import { appendSpend, computeSpendFromJsonl, loadAskOwner, loadBudgetConfig, runSpendCmd, type Spend } from "./budget";
import { buildAttemptPlan, getBreaker, hasFixedRuntime, loadEscalation } from "./escalation";
import { runGate } from "./gate";
import { killByPid } from "./pipeline";
import { procSampler, watchCfg } from "./proc_sample";
import { probe } from "./probe";
import { loadProject } from "./project";
import { resolveRuntime as defaultResolveRuntime } from "./runtime";
import { runtimeEnv } from "./runtime/env";
import { defaultSpawn, type FailureKind, type RunRequest, type RunResult, type RuntimeAdapter } from "./runtime/port";
import type { RunObs } from "./run_state";
import { createWorktree, git as gitCmd, mergeWorktreeInto, mergeWorktreeToTrunk, removeWorktree, worktreeOfBranch } from "./worktree";
import { checkPaidCall } from "./cost_cap";

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

/**
 * Hooks da vigia ao vivo (PLAN-0029 TASK-12): o `manda run` monta os reais
 * (`proc_sample` + `probe` + `killByPid`) e o teste injeta os seus. Sem
 * `watch`, a vigia real acompanha a tentativa.
 */
export interface WatchHooks {
  cfg: { patience_min: number; no_progress_min: number };
  sample: () => Promise<RunObs>;
  probe: (model: string) => Promise<{ ok: boolean }>;
  /** Mata o processo da tentativa pelo pid exposto por `onPid`. */
  kill: (pid: number) => void;
  sleep: (ms: number) => Promise<void>;
}

export interface RunOptions {
  root: string;
  plan: string;
  /** Roda só esta TASK (id completo ou `TASK-NN`). */
  task?: string;
  resolveRuntime?: ResolveRuntime;
  spendCmd?: string;
  approve?: string | string[];
  /** Injeção de teste dos hooks da vigia (default: vigia real). */
  watch?: WatchHooks;
  costCmd?: string[];
  nextEstimateUsd?: number;
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
  watch?: WatchHooks;
  costCmd?: string[];
  nextEstimateUsd?: number;
  runStartedAt: string;
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

/**
 * Vigia real da tentativa (PLAN-0029 TASK-12): cpu de `/proc/<pid>/stat`,
 * mudança de arquivo por `git status`, stream pelo tamanho dos eventos e
 * probe do modelo pelo `defaultSpawn`. O pid chega por `onPid`; se a
 * tentativa settleia antes dele, a amostragem desiste (o sampler lança e a
 * vigia encerra sem tocar em disjuntor nem evento).
 */
export function realWatchHooks(o: {
  root: string;
  worktree: string;
  cfg: { patience_min: number; no_progress_min: number };
  startedAt: number;
  pidReady: Promise<number>;
  stopped: Promise<void>;
  /** Stream da própria tentativa; nunca o log compartilhado de eventos. */
  streamPath?: string;
  /** Modelo sondado pelo sampler quando a tentativa parecer parada. */
  model?: string;
  /** Probe injetável; por padrão usa o runner real. */
  probe?: (model: string) => Promise<{ ok: boolean }>;
}): WatchHooks {
  const abandoned = o.stopped.then(() => null);
  const probeModel =
    o.probe ??
    ((model: string) =>
      probe(model, async (argv, probeOpts) => {
        const raw = await defaultSpawn(argv, { cwd: o.worktree, timeoutMs: probeOpts.timeout_ms });
        return { code: raw.exitCode, stdout: raw.stdout };
      }));
  let sampler: (() => Promise<RunObs>) | null = null;
  let samplerPid = -1;
  return {
    cfg: o.cfg,
    sample: async () => {
      const pid = await Promise.race([o.pidReady, abandoned]);
      if (pid === null) throw new Error("vigia: tentativa encerrada sem pid rastreável");
      if (!sampler || samplerPid !== pid) {
        sampler = procSampler({
          pid,
          worktree: o.worktree,
          streamPath: o.streamPath,
          startedAt: o.startedAt,
          model: o.model,
          probe: probeModel,
          cfg: o.cfg,
        });
        samplerPid = pid;
      }
      return sampler();
    },
    probe: probeModel,
    kill: (pid) => {
      killByPid(pid);
    },
    // Sleep interrompível: a parada acorda a vigia antes do próximo tick.
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        void o.stopped.then(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
}

async function runTask(task: TaskDoc, ctx: TaskContext): Promise<TaskOutcome> {
  const fullId = String(task.task);
  const eventTask = shortTaskId(fullId);
  // T916 (monorepo): `repo:` pode nomear um pacote — pasta de um repositório
  // maior. As worktrees são do repositório; o executor e o gate trabalham na
  // pasta do pacote dentro delas.
  const repoDir = repoOf(task, ctx.root);
  const pkg = existsSync(repoDir) ? gitCmd(["-C", repoDir, "rev-parse", "--show-prefix"], repoDir).stdout.trim().replace(/\/+$/, "") : "";
  const top = pkg !== "" ? gitCmd(["-C", repoDir, "rev-parse", "--show-toplevel"], repoDir).stdout.trim() : "";
  const repoRoot = pkg !== "" && top !== "" ? top : repoDir;
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
  // T905: com a branch do PLAN (`plan/NNNN`, criada pelo `manda red`) em
  // checkout numa worktree, a TASK nasce dela e volta para ela; a main só
  // anda pelo `manda merge`. Sem ela, vale o fluxo antigo (base = main).
  const planNumber = ctx.plan.match(/PLAN-(\d{4})/)?.[1];
  const planBranch = planNumber ? `plan/${planNumber}` : null;
  const planWorktree = planBranch ? worktreeOfBranch(repoRoot, planBranch) : null;
  const baseBranch = planBranch && planWorktree ? planBranch : BASE_BRANCH;
  // T908: worktree de TASK é efêmera. A que sobrou de uma tentativa que
  // falhou ou foi interrompida sai antes de criar a nova.
  await removeWorktree(repoRoot, worktreeId);
  const worktree = await createWorktree(repoRoot, worktreeId, baseBranch);
  const workdir = pkg !== "" && top !== "" ? join(worktree.path, pkg) : worktree.path;

  type AttemptSpec = { tier: string; entry: string; provider: string; model: string; runtime: string };
  let builtSpecs: AttemptSpec[] = [];
  if (!fixed && escalation) {
    builtSpecs = buildAttemptPlan(ctx.root, tier || "free") as AttemptSpec[];
  }
  const useLadder = builtSpecs.length > 0;
  const attemptSpecs: AttemptSpec[] =
    builtSpecs.length > 0
      ? builtSpecs
      : [{ tier: tier || "free", entry: "", provider: choice.name === "pi" && !(choice.model && choice.model.trim()) ? "opencode" : choice.name, model: choice.name === "pi" && !(choice.model && choice.model.trim()) ? "glm-5.3-flash-free" : (choice.model && choice.model.trim() ? choice.model : ""), runtime: choice.name }];

  const breaker = useLadder ? getBreaker(ctx.root) : { same_reason: 3, ignore: [] };
  const ignore = new Set((breaker.ignore ?? []).map((v: any) => String(v)));

  // PLAN-0029 TASK-11: com escada, o disjuntor vive no state.db compartilhado
  // (`$GINGA_STATE_DB` ou `<root>/.ginga/state/state.db`).
  const stateDb = useLadder ? openStateDb(ctx.root) : null;

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
    // Nome completo do modelo na escada (ex.: `opencode/f1`): é a chave do disjuntor.
    const fullModel = spec.entry || (spec.provider && spec.model ? `${spec.provider}/${spec.model}` : spec.model || "");

    // Disjuntor aberto no state.db: pula o modelo sem chamar o adapter.
    // Meio-aberto pode tentar (a janela de teste do breaker). Se todos os
    // candidatos estiverem abertos, a primeira tentativa ainda entra para a
    // vigia assumir a falha e o waitForFree procurar um probe saudável.
    const allCandidatesOpen =
      stateDb !== null &&
      attemptSpecs.every((candidate) => {
        const candidateModel =
          candidate.entry ||
          (candidate.provider && candidate.model
            ? `${candidate.provider}/${candidate.model}`
            : candidate.model || "");
        return (
          candidateModel !== "" &&
          breakerOf(stateDb!, candidateModel, new Date()).state === "open"
        );
      });
    if (
      stateDb &&
      fullModel &&
      breakerOf(stateDb, fullModel, new Date()).state === "open" &&
      !(allCandidatesOpen && attemptNo === 1)
    ) {
      emitEvent(
        "attempt",
        {
          runtime: spec.runtime,
          ...(spec.model ? { model: spec.model } : {}),
          tier: spec.tier,
          attempt_n: attemptNo,
          passed: false,
          breaker: "open",
          via: "breaker",
        },
        scope,
      );
      continue;
    }

    // Budget check antes de cada tentativa.
    let spent: Spend;
    try {
      spent = ctx.spendCmd
        ? runSpendCmd(ctx.spendCmd, ctx.plan, eventTask)
        : computeSpendFromJsonl(ctx.root, ctx.plan, eventTask);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        await removeWorktree(repoRoot, worktreeId);
      } catch {}
      emitEvent("transition", { entity: "task", from: "running", to: "blocked", by: "system", via: "cli" }, scope);
      emitEvent("blocker", { raised_by: "manda", blocker_id: randomUUID(), question: `TASK ${eventTask} bloqueada: falha no spend-cmd (${msg})`, options: ["retry", "skip", "abort"], scope: "task" }, scope);
      console.log(`[${eventTask}] blocked runtime=${lastAdapterName}`);
      return { task: eventTask, runtime: lastAdapterName, passed: false, ...(lastFailure ? { failure: lastFailure } : {}) };
    }
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

    // Sessão do guard de segredos (PLAN-0033 TASK-09): o `manda run` real
    // sempre roda com o guard ligado. A marca exportada pelo processo
    // (`lane.sh`/`dispatch-task.sh` via `guard_export`) vence; sem ela, deriva
    // `<PLAN>/<TASK>` em minúsculas (ex.: `plan-0033/task-07`) — a derivação é
    // o padrão, nunca o opt-in.
    const guardLane =
      process.env.GINGA_GUARD_LANE ?? `${ctx.plan}/${shortTaskId(fullId)}`.toLowerCase();

    const request: RunRequest = {
      worktree: workdir,
      prompt: formatTaskPrompt(task, {
        plan: ctx.plan,
        repo: repoRoot,
        worktree: workdir,
      }),
      role: "executor",
      logPath: join(ctx.root, "runs", ctx.plan, `${eventTask}-attempt-${attemptNo}.log`),
      // `runtimeEnv` carimba GINGA_GUARD (padrão `enforce`) e GINGA_GUARD_LOG
      // (<root>/handoffs/guard.events.jsonl) quando há lane; GINGA_GUARD=off do
      // processo deixa o guard inerte (sessão do dono).
      env: runtimeEnv({ ...process.env, G: ctx.root, GINGA_GUARD_LANE: guardLane }),
    };
    const modelForRequest = spec.model ?? (request.model as string | undefined) ?? (task as any).model;
    if (spec.model) request.model = spec.model;
    else if (modelForRequest && (adapter.name === choice.name || spec.runtime === choice.name)) {
      // keep as is
    }
    if (spec.provider) request.provider = spec.provider;

    const nextEstimateUsd = typeof ctx.nextEstimateUsd === "number" ? ctx.nextEstimateUsd : 0.15;
    const costCheck = checkPaidCall({
      root: ctx.root,
      since: ctx.runStartedAt,
      next_estimate_usd: nextEstimateUsd,
      model: modelForRequest ?? (request.model as string | undefined) ?? (spec.model as string | undefined),
      costCmd: ctx.costCmd,
    });
    if (!costCheck.allow) {
      try {
        await removeWorktree(repoRoot, worktreeId);
      } catch {}
      emitEvent("budget", { level: "cap", scope: "task", cap_usd: 0, spent_usd: 0 }, scope);
      emitEvent("transition", { entity: "task", from: "running", to: "blocked", by: "system", via: "cli" }, scope);
      emitEvent("blocker", { raised_by: "manda", blocker_id: randomUUID(), question: `TASK ${eventTask} bloqueada por budget`, options: ["retry", "skip", "abort"], scope: "task" }, scope);
      console.log(`[${eventTask}] blocked runtime=${lastAdapterName}`);
      return { task: eventTask, runtime: lastAdapterName, passed: false };
    }

    const started = Date.now();

    // Vigia ao vivo (PLAN-0029 TASK-12): enquanto a tentativa roda, amostra o
    // processo e troca de modelo sem esperar o adapter devolver.
    const watching = Boolean(stateDb && fullModel);
    let pidResolve: (pid: number) => void = () => {};
    const pidReady = new Promise<number>((resolve) => {
      pidResolve = resolve;
    });
    let stopResolve: () => void = () => {};
    const watchStopped = new Promise<void>((resolve) => {
      stopResolve = resolve;
    });
    let stopWatch = false;
    // Pid exposto pelo adapter (via `onPid`); `null` enquanto não chega.
    let pid: number | null = null;
    if (watching) {
      request.onPid = (pidValue: number) => {
        pid = pidValue;
        pidResolve(pidValue);
      };
    }

    const hooks: WatchHooks = ctx.watch ??
      realWatchHooks({
        root: ctx.root,
        worktree: workdir,
        cfg: watchCfg(ctx.root),
        startedAt: started,
        pidReady,
        stopped: watchStopped,
        streamPath: request.logPath,
        model: fullModel,
      });

    // Adapter que nunca rejeita: a falha de infra entra como resultado.
    const runPromise: Promise<RunResult> = (async () => {
      try {
        return await adapter.run(request);
      } catch (error) {
        return {
          passed: false,
          failure: "infra",
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    })();

    // A vigia corre em paralelo; `watcherOutcome` só é preenchido quando ela
    // vence (trocou de modelo ou esgotou a fila) — nesse caso ela já matou,
    // já abriu o disjuntor e já emitiu o `attempt` (sem duplicata aqui).
    let watcherOutcome: { outcome: "switched" | "waiting"; next?: string } | null = null;
    let watcherTookOver = false;
    const watchPromise: Promise<void> = watching
      ? watchAttempt({
          sample: hooks.sample,
          kill: () => {
            // O watcher chama kill sem argumentos: o pid vem do `onPid`.
            if (pid !== null) hooks.kill(pid);
          },
          probe: hooks.probe,
          sleep: hooks.sleep,
          db: stateDb!,
          model: fullModel,
          cfg: hooks.cfg,
          stop: () => stopWatch,
          onTakeOver: () => {
            watcherTookOver = true;
          },
          root: ctx.root,
        }).then(
          (r) => {
            if (r.outcome !== "done") watcherOutcome = r;
          },
          () => {},
        )
      : Promise.resolve();

    const result = await runPromise;
    const durationMs = Date.now() - started;
    // A tentativa settleou: a vigia não pode mais matar nem registrar nada.
    // Depois de a vigia assumir a falha, seu waitForFree precisa continuar.
    if (!watcherTookOver) {
      stopWatch = true;
      stopResolve();
    }
    if (watching) await watchPromise;
    const watcherActed = watcherOutcome !== null;

    let attemptPassed: boolean;
    let attemptFailure: FailureKind | undefined;
    if (watcherActed) {
      // O watcher venceu: o run settleia como falha (morto pelo pid).
      attemptPassed = false;
      attemptFailure = result.failure ?? "infra";
    } else {
      attemptPassed = result.passed;
      attemptFailure = attemptPassed ? undefined : (result.failure ?? "infra");

      if (attemptPassed) {
        const gate = await runGate({
          task: `${ctx.plan}/${eventTask}`,
          plan: ctx.plan,
          repo: repoRoot,
          worktree: workdir,
          doneWhen: stringField(task, "done_when"),
          base: baseBranch,
          testsFrozen: listField(task, "tests_frozen"),
          gateId: stringField(task, "pinga_task"),
          root: ctx.root,
        });
        if (!gate.passed) {
          attemptPassed = false;
          attemptFailure = "done_when";
        }
      }
    }

    if (attemptPassed) {
      try {
        if (planWorktree && baseBranch !== BASE_BRANCH) await mergeWorktreeInto(repoRoot, worktreeId, planWorktree);
        else await mergeWorktreeToTrunk(repoRoot, worktreeId, BASE_BRANCH);
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

    // Vigia da tentativa (PLAN-0029 TASK-09/11): a recusa final abre o
    // disjuntor no state.db compartilhado e o próximo modelo livre sai da
    // escada; o sucesso fecha o disjuntor. O evento `attempt` segue único,
    // emitido aqui pelo fluxo principal (quando a vigia venceu, ela já emitiu
    // o dele e não duplicamos aqui).
    let nextModel: string | null = null;
    if (stateDb && fullModel && !watcherActed) {
      if (passed) {
        recordSuccess(stateDb, fullModel);
      } else if (attemptFailure) {
        nextModel = planNextAfterFailure({
          root: ctx.root,
          db: stateDb,
          model: fullModel,
          reason: String(attemptFailure),
        }).next;
      }
    }

    if (!watcherActed) {
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
          ...(nextModel ? { next_model: nextModel } : {}),
          duration_ms: durationMs,
          tokens_in: usage?.inputTokens ?? 0,
          tokens_out: usage?.outputTokens ?? 0,
          cost_usd: result.costUsd ?? 0,
          cost_source: result.costUsd === undefined ? "unknown" : "metered",
        },
        scope,
      );
    }

    if (watcherActed) {
      // A vigia venceu: ela já matou pelo pid, abriu o disjuntor, escolheu o
      // próximo e emitiu o `attempt`. Sem próximo modelo (`waiting`) o laço
      // acabou; senão, o próximo spec entra sem evento duplicado.
      if (watcherOutcome!.outcome === "waiting") break;
      continue;
    }

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
    ...(opts.watch ? { watch: opts.watch } : {}),
    costCmd: opts.costCmd,
    nextEstimateUsd: opts.nextEstimateUsd,
    runStartedAt: new Date().toISOString(),
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
