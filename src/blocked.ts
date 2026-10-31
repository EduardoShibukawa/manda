import { readFileSync } from "node:fs";
import { join } from "node:path";

import { emitEvent } from "../src/events";

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

interface FailureRule {
  class: BlockedClass;
  action: BlockedAction;
  pattern: string;
}

const rules: FailureRule[] = JSON.parse(
  readFileSync(join(import.meta.dir, "failure_rules.json"), "utf8"),
);

export function classifyBlocked(text: string): {
  class: BlockedClass;
  action: BlockedAction;
  evidence: string;
} {
  for (const rule of rules) {
    const re = new RegExp(rule.pattern, "i");
    const match = text.match(re);
    if (match) {
      emitEvent("gate.fail", {
        classification: { class: rule.class, action: rule.action, evidence: match[0] },
      });
      return { class: rule.class, action: rule.action, evidence: match[0] };
    }
  }
  emitEvent("gate.fail", {
    classification: { class: "other", action: "notify", evidence: "sem padrão conhecido" },
  });
  return { class: "other", action: "notify", evidence: "sem padrão conhecido" };
}
