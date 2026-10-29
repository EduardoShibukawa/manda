export interface CapInput {
  spent_usd: number;
  next_estimate_usd: number;
  cap_usd: number;
}

export interface CapResult {
  allow: boolean;
  reason: string;
}

export function capCheck(_input: CapInput): CapResult {
  return { allow: true, reason: "stub" };
}

export interface SpentInput {
  since: string;
  opencodeDb: string;
  claudeCosts: number[];
}

export function spentUsd(_input: SpentInput): number {
  return 0;
}
