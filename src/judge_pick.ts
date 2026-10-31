/* STUB — TASK-08 RED: retorna null para provar RED por asserção. */
import type { BreakerState } from "./breaker";

export function pickJudge(_o: {
  pool: string[];
  executorModel: string;
  breaker: (m: string) => BreakerState;
  quota: (m: string) => number | null;
}): string | null {
  return null; // errado: deveria aplicar as regras de filtragem
}
