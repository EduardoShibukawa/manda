import type { BreakerState } from "./breaker";
import { modelFamily } from "./family";

export function pickJudge(o: {
  pool: string[];
  executorModel: string;
  breaker: (m: string) => BreakerState;
  quota: (m: string) => number | null;
}): string | null {
  const executorFamily = modelFamily(o.executorModel);

  for (const model of o.pool) {
    if (modelFamily(model) === executorFamily) continue;
    if (o.breaker(model) === "open") continue;

    const usedPct = o.quota(model);
    if (usedPct !== null && usedPct >= 100) continue;

    return model;
  }

  return null;
}
