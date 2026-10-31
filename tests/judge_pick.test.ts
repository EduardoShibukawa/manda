import { describe, expect, test } from "bun:test";

import { pickJudge } from "../src/judge_pick";
import type { BreakerState } from "../src/breaker";

function makeBreaker(states: Record<string, BreakerState>): (m: string) => BreakerState {
  return (m: string) => states[m] ?? "closed";
}

const POOL = ["agy/gemini-3.8-flash", "codex/gpt-6-luna"];

describe("pickJudge — skip same family", () => {
  test("executor codex (gpt) → pula family gpt no pool", () => {
    const r = pickJudge({
      pool: POOL,
      executorModel: "codex/gpt-4",
      breaker: makeBreaker({}),
      quota: () => null,
    });
    expect(r).toBe("agy/gemini-3.8-flash");
  });
});

describe("pickJudge — skip quota 100%", () => {
  test("codex quota 100% → pula, pega outro da família diferente", () => {
    const r = pickJudge({
      pool: POOL,
      executorModel: "claude/opus-5-5",
      breaker: makeBreaker({}),
      quota: (m: string) => (m === "codex/gpt-6-luna" ? 100 : null),
    });
    expect(r).toBe("agy/gemini-3.8-flash");
  });
});

describe("pickJudge — skip breaker open", () => {
  test("breaker open → pula modelo", () => {
    const r = pickJudge({
      pool: POOL,
      executorModel: "claude/opus-5-5",
      breaker: makeBreaker({ "codex/gpt-6-luna": "open" }),
      quota: () => null,
    });
    expect(r).toBe("agy/gemini-3.8-flash");
  });
});

describe("pickJudge — all skipped", () => {
  test("nada disponível → null", () => {
    const r = pickJudge({
      pool: ["codex/gpt-6-luna"],
      executorModel: "codex/gpt-4",
      breaker: makeBreaker({}),
      quota: () => 100,
    });
    expect(r).toBeNull();
  });
});
