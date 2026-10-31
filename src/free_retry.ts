/** Escada de espera em minutos: 15, 30, 60, 60... (teto em 60). */
const RETRY_STEPS_MIN = [15, 30, 60];

/**
 * Espera (ms) antes da n-ésima nova tentativa de um modelo free com cota
 * esgotada. Sobe 15 → 30 → 60 e estaciona em 60 (teto).
 */
export function freeRetryWait(n: number): number {
  const minutes = RETRY_STEPS_MIN[Math.min(n, RETRY_STEPS_MIN.length) - 1];
  return minutes * 60_000;
}

/**
 * Com a cota free esgotada, espera com backoff (15, 30, 60, 60... min) e só
 * devolve o modelo depois de um probe ok. Devolve `null` ao sinal de parada.
 *
 * - Varre os models `free`; o 1º com probe ok já é devolvido (sem dormir).
 * - Se nenhum passar na varredura, laço de backoff reprobando o 1º free.
 * - `stop()` é honrado o mais cedo possível.
 */
export async function waitForFree(o: {
  free: string[];
  probe: (m: string) => Promise<{ ok: boolean }>;
  sleep: (ms: number) => Promise<void>;
  stop: () => boolean;
}): Promise<string | null> {
  const { free, probe, sleep, stop } = o;
  if (free.length === 0) return null;
  if (stop()) return null;

  // 1. Varre os models free: o 1º com probe ok é devolvido sem dormir.
  for (const m of free) {
    if (stop()) return null;
    if ((await probe(m)).ok) return m;
  }

  // 2. Nenhum ok na varredura → laço de backoff reprobando o 1º free.
  let n = 0;
  while (!stop()) {
    n += 1;
    await sleep(freeRetryWait(n));
    if (stop()) return null;
    if ((await probe(free[0])).ok) return free[0];
  }

  return null;
}
