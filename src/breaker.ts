export type BreakerState = "closed" | "open" | "half_open";

export type BreakerInfo = {
  state: BreakerState;
  until: string | null;
  level: number;
};

export function breakerOf(): BreakerInfo {
  throw new Error("not implemented");
}

export function recordFailure(): void {
  throw new Error("not implemented");
}

export function recordSuccess(): void {
  throw new Error("not implemented");
}
