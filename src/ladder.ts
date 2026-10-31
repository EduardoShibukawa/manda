/* STUB — TASK-04 RED: pickModel sempre retorna null.
 * O teste falha por asserção (não por import), provando RED. */
import type { BreakerState } from "../src/breaker";

export function providerOf(_model: string): string {
  return "";
}

export function pickModel(_o: {
  tier: string;
  pools: Record<string, string[]>;
  free: string[];
  allowPaid: boolean;
  capOk: boolean;
  mitRepo: boolean;
  breaker: (m: string) => BreakerState;
}): { model: string | null; reason: string } {
  return { model: null, reason: "STUB" };
}
