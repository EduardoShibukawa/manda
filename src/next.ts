/**
 * Máquina de estados de um PLAN (T909). A visão 02 põe as transições de um
 * run no orquestrador: esta função é pura, sem LLM e sem I/O. O `ginga tick`
 * continua dono da fila, do lease e de gravar a fase; ele pergunta aqui qual
 * é o próximo verbo (`manda next`, estado por stdin).
 *
 * Portada de `g-inga/src/tick_plan.ts` (PLAN-0028), com uma regra a mais:
 * veredito `fail` do judge leva a replan, não fica parado.
 */

export type ActionCmd = "red" | "run" | "judge" | "merge" | "replan" | "notify" | "none";

export interface Action {
  cmd: ActionCmd;
  plan: string;
  task?: string;
  reason: string;
}

export interface TaskState {
  /** `PLAN-NNNN/TASK-NN` ou só `TASK-NN`. */
  id: string;
  status: "open" | "pass" | "fail" | "blocked";
  attempts: number;
  deps_done: boolean;
}

export interface PlanState {
  /** approved | red | tasks | judge | replan | done */
  phase: string;
  tasks: TaskState[];
  cap_ok: boolean;
  /** Veredito do judge: "pass", "fail", "high" (falha grave) ou ausente. */
  judge?: string;
  /** Id do PLAN quando não dá para tirar das TASKs. */
  plan?: string;
}

/** Tentativas com falha que disparam o replan de uma TASK. */
export const REPLAN_AFTER = 3;

const planOf = (id: string) => (id.includes("/") ? id.split("/")[0]! : id);
const shortId = (id: string) => (id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id);

function nextTaskAction(plan: string, tasks: TaskState[]): Action {
  const open = tasks.find((t) => t.status === "open" && t.deps_done);
  if (open) return { cmd: "run", plan, task: shortId(open.id), reason: "executar tarefa aberta com dependências prontas" };
  if (tasks.length > 0 && tasks.every((t) => t.status === "pass")) {
    return { cmd: "judge", plan, reason: "todas as tarefas aprovadas → juiz" };
  }
  return { cmd: "none", plan, reason: "sem ação" };
}

export function nextAction(state: PlanState): Action {
  const plan = state.plan ?? (state.tasks[0] ? planOf(state.tasks[0].id) : "");
  if (state.cap_ok === false) return { cmd: "notify", plan, reason: "capacidade/limites indisponíveis" };

  switch (state.phase) {
    case "approved":
      return { cmd: "red", plan, reason: "plano aprovado → iniciar RED" };
    case "red":
      return nextTaskAction(plan, state.tasks);
    case "tasks": {
      const failed = state.tasks.find((t) => t.status === "fail" && t.attempts >= REPLAN_AFTER);
      if (failed) return { cmd: "replan", plan, task: shortId(failed.id), reason: `tarefa com ${REPLAN_AFTER} falhas → replan` };
      return nextTaskAction(plan, state.tasks);
    }
    case "judge":
      if (state.judge === "pass") return { cmd: "merge", plan, reason: "juiz aprovou → merge" };
      if (state.judge === "high") return { cmd: "replan", plan, reason: "juiz com alta gravidade → replan" };
      if (state.judge === "fail") return { cmd: "replan", plan, reason: "juiz reprovou → replan" };
      return { cmd: "none", plan, reason: "aguardando decisão do juiz" };
    case "done":
      return { cmd: "none", plan, reason: "concluído" };
    default:
      return { cmd: "none", plan, reason: "sem ação" };
  }
}

function isPlanState(v: unknown): v is PlanState {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.phase === "string" && Array.isArray(o.tasks);
}

/** `manda next`: estado em JSON por stdin, ação em uma linha por stdout. */
export async function nextMain(): Promise<number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.stdin.text());
  } catch {
    console.error("manda next: stdin não é JSON");
    return 2;
  }
  if (!isPlanState(parsed)) {
    console.error('manda next: estado inválido (esperado {"phase","tasks",...})');
    return 2;
  }
  console.log(JSON.stringify(nextAction({ ...parsed, cap_ok: parsed.cap_ok !== false })));
  return 0;
}

if (import.meta.main) {
  process.exit(await nextMain());
}
