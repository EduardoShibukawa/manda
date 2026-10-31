import type { BreakerState } from "../src/breaker";

export function providerOf(model: string): string {
  const idx = model.indexOf("/");
  return idx >= 0 ? model.slice(0, idx) : model;
}

export function pickModel(o: {
  tier: string;
  pools: Record<string, string[]>;
  free: string[];
  allowPaid: boolean;
  capOk: boolean;
  mitRepo: boolean;
  breaker: (m: string) => BreakerState;
}): { model: string | null; reason: string } {
  const { tier, pools, free, allowPaid, capOk, mitRepo, breaker } = o;

  // Itera free: pula breakers open, pula iceman* quando !mitRepo
  for (const m of free) {
    if (breaker(m) === "open") continue;
    if (!mitRepo && m.startsWith("iceman")) continue;
    return { model: m, reason: `free (${providerOf(m)})` };
  }

  // Todos free abertos ou skipados
  if (!allowPaid) {
    return { model: null, reason: "todos free abertos; allowPaid: false" };
  }
  if (!capOk) {
    return { model: null, reason: "todos free abertos; capOk: false" };
  }

  const pool = pools[tier];
  if (!pool || pool.length === 0) {
    return { model: null, reason: `pool pago ${tier} vazio` };
  }

  for (const m of pool) {
    if (breaker(m) === "open") continue;
    return { model: m, reason: `paid pool ${tier}` };
  }

  return { model: null, reason: `pool pago ${tier} todo aberto` };
}
