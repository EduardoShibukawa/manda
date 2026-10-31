/* STUB — TASK-06 RED: retorna valores errados para provar RED por asserção.
 * O teste falha por asserção (não por import), provando RED. */

export function freeRetryWait(n: number): number {
  return n; // errado: deveria ser minutos em ms
}

export async function waitForFree(_o: {
  free: string[];
  probe: (m: string) => Promise<{ ok: boolean }>;
  sleep: (ms: number) => Promise<void>;
  stop: () => boolean;
}): Promise<string | null> {
  return null; // errado: deveria tentar probear os modelos
}
