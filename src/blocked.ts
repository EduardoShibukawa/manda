/* STUB — TASK-07 RED: classifyBlocked sempre retorna "other/notify".
 * O teste falha por asserção (não por import), provando RED. */

export type BlockedClass =
  | "contract_conflict"
  | "missing_dep"
  | "env_dependency"
  | "id_collision"
  | "gate_false_positive"
  | "scope_drift"
  | "quota"
  | "other";

export type BlockedAction =
  | "auto_unblock"
  | "retry_clean"
  | "skip_tier"
  | "replan"
  | "notify";

export function classifyBlocked(_text: string): {
  class: BlockedClass;
  action: BlockedAction;
  evidence: string;
} {
  return { class: "other", action: "notify", evidence: "STUB" };
}
