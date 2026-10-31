/* STUB — TASK-10 RED: retorna valores errados para provar RED por asserção.
 * O teste falha por asserção (não por import), provando RED. */
import type { Database } from "bun:sqlite";
import type { BreakerState } from "./breaker";

export function breakerStatus(
  _db: Database,
  _now: Date,
): { model: string; state: BreakerState; until: string | null; level: number; last_reason: string | null }[] {
  return []; // errado: deveria listar os modelos da tabela model_breaker
}

export function breakerReset(_db: Database, _model: string): void {
  // errado: deveria chamar recordSuccess e emitir evento transition
}
