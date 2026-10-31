import { describe, expect, test } from "bun:test";

import { freeRetryWait, waitForFree } from "../src/free_retry";

describe("freeRetryWait", () => {
  test("n=1 → 15 minutos em ms", () => {
    expect(freeRetryWait(1)).toBe(15 * 60_000);
  });

  test("n=2 → 30 minutos em ms", () => {
    expect(freeRetryWait(2)).toBe(30 * 60_000);
  });

  test("n=3 → 60 minutos em ms", () => {
    expect(freeRetryWait(3)).toBe(60 * 60_000);
  });

  test("n=10 → 60 minutos em ms (teto)", () => {
    expect(freeRetryWait(10)).toBe(60 * 60_000);
  });
});

describe("waitForFree", () => {
  test("probe falha 2× e passa → dormiu 15+30 min e devolve o modelo", async () => {
    const sleeps: number[] = [];
    let probeCalls = 0;
    const r = await waitForFree({
      free: ["opencode/glm-5.3-flash-free"],
      probe: async () => {
        probeCalls++;
        return { ok: probeCalls >= 3 };
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      stop: () => false,
    });
    expect(r).toBe("opencode/glm-5.3-flash-free");
    expect(sleeps).toEqual([15 * 60_000, 30 * 60_000]);
  });

  test("stop() → null", async () => {
    const r = await waitForFree({
      free: ["m1"],
      probe: async () => ({ ok: false }),
      sleep: async () => {},
      stop: () => true,
    });
    expect(r).toBeNull();
  });

  test("múltiplos modelos: 2º tem probe ok → devolvido sem dormir", async () => {
    const sleeps: number[] = [];
    const r = await waitForFree({
      free: ["m1", "m2"],
      probe: async (m: string) => ({ ok: m === "m2" }),
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      stop: () => false,
    });
    expect(r).toBe("m2");
    expect(sleeps).toHaveLength(0);
  });
});
