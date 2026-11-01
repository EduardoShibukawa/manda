import { describe, expect, test } from "bun:test";

import { pickModel } from "../src/ladder";
import type { BreakerState } from "../src/breaker";

function makeBreaker(states: Record<string, BreakerState>): (m: string) => BreakerState {
  return (m: string) => states[m] ?? "closed";
}

describe("pickModel — free closed", () => {
  test("todos free fechados → 1º free", () => {
    const free = ["opencode/glm-5.3-flash-free", "opencode/deepseek-v4.1-flash-free"];
    const r = pickModel({
      tier: "light",
      pools: { paid: ["opencode/deepseek-v4-pro"] },
      free,
      allowPaid: false,
      capOk: false,
      mitRepo: true,
      breaker: makeBreaker({}),
    });
    expect(r.model).toBe("opencode/glm-5.3-flash-free");
    expect(r.reason).toMatch(/free/i);
  });
});

describe("pickModel — pula open, alterna provider", () => {
  test("1º free aberto → 2º de outro provider", () => {
    const free = ["opencode/glm-5.3-flash-free", "opencode-go/deepseek-v4.1-flash"];
    const r = pickModel({
      tier: "light",
      pools: {},
      free,
      allowPaid: false,
      capOk: false,
      mitRepo: true,
      breaker: makeBreaker({ "opencode/glm-5.3-flash-free": "open" }),
    });
    expect(r.model).toBe("opencode-go/deepseek-v4.1-flash");
    expect(r.reason).toMatch(/free/i);
  });
});

describe("pickModel — all free open", () => {
  test("todos free abertos e allowPaid: false → null", () => {
    const free = ["opencode/glm-5.3-flash-free", "opencode-go/deepseek-v4.1-flash"];
    const states: Record<string, BreakerState> = {};
    for (const m of free) states[m] = "open";
    const r = pickModel({
      tier: "light",
      pools: { paid: ["opencode/deepseek-v4-pro"] },
      free,
      allowPaid: false,
      capOk: false,
      mitRepo: true,
      breaker: makeBreaker(states),
    });
    expect(r.model).toBeNull();
    expect(r.reason).toMatch(/aberto|allowPaid|nenhum/i);
  });
});

describe("pickModel — mitRepo false", () => {
  test("mitRepo: false pula iceman*", () => {
    const free = ["opencode/glm-5.3-flash-free", "iceman/qwen3.8-flash"];
    const r = pickModel({
      tier: "light",
      pools: {},
      free,
      allowPaid: false,
      capOk: false,
      mitRepo: false,
      breaker: makeBreaker({}),
    });
    expect(r.model).toBe("opencode/glm-5.3-flash-free");
    expect(r.model).not.toBe("iceman/qwen3.8-flash");
  });
});

describe("pickModel — paid fallback", () => {
  test("todos free abertos, allowPaid+capOk → 1º do pool pago", () => {
    const free = ["opencode/glm-5.3-flash-free"];
    const r = pickModel({
      tier: "light",
      pools: { light: ["opencode/deepseek-v4-pro", "opencode/anthropic-claude"] },
      free,
      allowPaid: true,
      capOk: true,
      mitRepo: true,
      breaker: makeBreaker({ "opencode/glm-5.3-flash-free": "open" }),
    });
    expect(r.model).toBe("opencode/deepseek-v4-pro");
    expect(r.reason).toMatch(/paid/i);
  });
});
