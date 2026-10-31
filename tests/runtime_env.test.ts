import { describe, expect, test } from "bun:test";
import { runtimeEnv, SPAWN_STDIN } from "../src/runtime/env";
import { RUNTIME_NAMES, resolveRuntime } from "../src/runtime/index";

describe("runtimeEnv", () => {
  test("adiciona PYTHONDONTWRITEBYTECODE=1 preservando o base", () => {
    const env = runtimeEnv({ FOO: "bar", BAZ: "qux" });
    expect(env.PYTHONDONTWRITEBYTECODE).toBe("1");
    expect(env.FOO).toBe("bar");
    expect(env.BAZ).toBe("qux");
  });

  test("valores undefined são filtrados (não viram string 'undefined')", () => {
    const env = runtimeEnv({ FOO: undefined, BAR: "baz" });
    expect(env.PYTHONDONTWRITEBYTECODE).toBe("1");
    expect(env.FOO).toBeUndefined();
    expect(env.BAR).toBe("baz");
  });

  test("env vazio recebe apenas a variável", () => {
    const env = runtimeEnv({});
    expect(env.PYTHONDONTWRITEBYTECODE).toBe("1");
    expect(Object.keys(env).length).toBe(1);
  });
});

describe("SPAWN_STDIN", () => {
  test("é 'ignore'", () => {
    expect(SPAWN_STDIN).toBe("ignore");
  });
});

describe("resolveRuntime injeta env padrão em todos os runtimes", () => {
  type Call = { cmd: string[]; env?: Record<string, string>; stdin?: string };
  type SpawnResult = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };

  function makeSpy() {
    const calls: Call[] = [];
    const spawn = async (cmd: string[], o: { cwd: string; env?: Record<string, string>; timeoutMs?: number; stdin?: string }): Promise<SpawnResult> => {
      calls.push({ cmd, env: o?.env, stdin: o?.stdin });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    return { spawn, calls };
  }

  const REQ = {
    worktree: "/tmp/wt",
    prompt: "test",
    env: { PI_CODEX_ENABLED: "1" },
    timeoutMs: 5_000,
    provider: "opencode",
    model: "qwen3.8-flash",
    role: "planner" as const,
  };

  for (const name of RUNTIME_NAMES) {
    test(`${name}: spawn recebe PYTHONDONTWRITEBYTECODE e stdin=ignore`, async () => {
      const s = makeSpy();
      const adapter = resolveRuntime(name, { spawn: s.spawn });
      // códigos de saída variam por parser; o teste cobre só o spawn.
      await adapter.run(REQ).catch(() => {});
      expect(s.calls.length).toBeGreaterThan(0);
      expect(s.calls[0].env?.PYTHONDONTWRITEBYTECODE).toBe("1");
      expect(s.calls[0].stdin).toBe("ignore");
    });
  }
});
