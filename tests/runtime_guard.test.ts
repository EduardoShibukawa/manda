import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRuntime } from "../src/runtime/index";

/**
 * RED do PLAN-0033 TASK-07 (congelado): os runtimes pi e opencode do `manda run`
 * ligam o guard de segredos quando há sessão de lane (GINGA_GUARD_LANE no env) e
 * GINGA_GUARD != "off" (padrão enforce):
 * - env do spawn leva GINGA_GUARD_LANE, GINGA_GUARD (padrão "enforce") e GINGA_GUARD_LOG;
 * - argv do pi leva `-e <GUARD_DIR>/contrib/guard/pi.ts` (coexiste com outros `-e`);
 * - env do opencode leva OPENCODE_CONFIG_DIR=<GUARD_DIR>/contrib/guard/opencode-config;
 * - guard ausente com guard ligado → a tentativa NÃO é spawnada e falha `guard_missing`;
 * - sem GINGA_GUARD_LANE (sessão do dono) ou GINGA_GUARD=off → guard inerte, sem `-e`/OPENCODE_CONFIG_DIR.
 * GUARD_DIR vem do env do request (padrão: checkout da main do ginga).
 */

type Raw = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };
type Call = { cmd: string[]; env?: Record<string, string>; stdin?: string };

function stub(raw: Raw = { exitCode: 0, stdout: "", stderr: "" }) {
  const calls: Call[] = [];
  const spawn = async (cmd: string[], o: { env?: Record<string, string>; stdin?: string }) => {
    calls.push({ cmd, env: o?.env, stdin: o?.stdin });
    return raw;
  };
  return { spawn, calls };
}

let GUARD: string; // checkout "ginga" falso, com o guard instalado
let EMPTY: string; // dir vazio: guard ausente
beforeAll(() => {
  GUARD = mkdtempSync(join(tmpdir(), "manda-guard-"));
  mkdirSync(join(GUARD, "contrib", "guard", "opencode-config"), { recursive: true });
  mkdirSync(join(GUARD, "src", "guard"), { recursive: true });
  writeFileSync(join(GUARD, "contrib", "guard", "pi.ts"), "// guard pi\n");
  writeFileSync(join(GUARD, "contrib", "guard", "opencode.ts"), "// guard opencode\n");
  writeFileSync(join(GUARD, "src", "guard", "cli.ts"), "// guard cli\n");
  EMPTY = mkdtempSync(join(tmpdir(), "manda-guard-vazio-"));
});
afterAll(() => {
  rmSync(GUARD, { recursive: true, force: true });
  rmSync(EMPTY, { recursive: true, force: true });
});

const LANE = "plan-0033/t319";
const req = (env: Record<string, string>) => ({
  worktree: "/tmp/wt-guard",
  prompt: "teste",
  model: "glm-5.3-flash-free",
  provider: "opencode",
  timeoutMs: 5000,
  env,
});

describe("guard nos runtimes (PLAN-0033 TASK-07)", () => {
  test("pi: env do spawn leva GINGA_GUARD_LANE, GINGA_GUARD=enforce (padrão) e GINGA_GUARD_LOG", async () => {
    const s = stub();
    const adapter = resolveRuntime("pi", { spawn: s.spawn });
    await adapter.run(req({ GINGA_GUARD_LANE: LANE, GUARD_DIR: GUARD }));
    expect(s.calls.length).toBe(1);
    const env = s.calls[0].env ?? {};
    expect(env.GINGA_GUARD_LANE).toBe(LANE);
    expect(env.GINGA_GUARD).toBe("enforce");
    expect(typeof env.GINGA_GUARD_LOG).toBe("string");
    expect((env.GINGA_GUARD_LOG ?? "").length).toBeGreaterThan(0);
  });

  test("pi: argv leva -e <GUARD_DIR>/contrib/guard/pi.ts", async () => {
    const s = stub();
    const adapter = resolveRuntime("pi", { spawn: s.spawn });
    await adapter.run(req({ GINGA_GUARD_LANE: LANE, GUARD_DIR: GUARD }));
    expect(s.calls.length).toBe(1);
    const cmd = s.calls[0].cmd;
    const i = cmd.indexOf("-e");
    expect(i).toBeGreaterThan(-1);
    expect(cmd[i + 1]).toBe(join(GUARD, "contrib", "guard", "pi.ts"));
  });

  test("pi: GINGA_GUARD e GINGA_GUARD_LOG explícitos são preservados", async () => {
    const s = stub();
    const adapter = resolveRuntime("pi", { spawn: s.spawn });
    await adapter.run(
      req({ GINGA_GUARD_LANE: LANE, GUARD_DIR: GUARD, GINGA_GUARD: "shadow", GINGA_GUARD_LOG: "/tmp/g.jsonl" }),
    );
    const env = s.calls[0].env ?? {};
    expect(env.GINGA_GUARD).toBe("shadow");
    expect(env.GINGA_GUARD_LOG).toBe("/tmp/g.jsonl");
  });

  test("opencode: env do spawn leva OPENCODE_CONFIG_DIR=<GUARD_DIR>/contrib/guard/opencode-config", async () => {
    const s = stub();
    const adapter = resolveRuntime("opencode", { spawn: s.spawn });
    await adapter.run(req({ GINGA_GUARD_LANE: LANE, GUARD_DIR: GUARD }));
    expect(s.calls.length).toBe(1);
    const env = s.calls[0].env ?? {};
    expect(env.GINGA_GUARD_LANE).toBe(LANE);
    expect(env.OPENCODE_CONFIG_DIR).toBe(join(GUARD, "contrib", "guard", "opencode-config"));
  });

  test("guard ausente (pi): não spawna e falha guard_missing", async () => {
    const s = stub();
    const adapter = resolveRuntime("pi", { spawn: s.spawn });
    const r = await adapter.run(req({ GINGA_GUARD_LANE: LANE, GUARD_DIR: EMPTY }));
    expect(s.calls.length).toBe(0);
    expect(r.passed).toBe(false);
    expect(r.failure).toBe("guard_missing");
  });

  test("guard ausente (opencode): não spawna e falha guard_missing", async () => {
    const s = stub();
    const adapter = resolveRuntime("opencode", { spawn: s.spawn });
    const r = await adapter.run(req({ GINGA_GUARD_LANE: LANE, GUARD_DIR: EMPTY }));
    expect(s.calls.length).toBe(0);
    expect(r.passed).toBe(false);
    expect(r.failure).toBe("guard_missing");
  });

  test("GINGA_GUARD=off desliga: spawna mesmo com GUARD_DIR vazio, sem -e nem OPENCODE_CONFIG_DIR", async () => {
    const sp = stub();
    const pi = resolveRuntime("pi", { spawn: sp.spawn });
    await pi.run(req({ GINGA_GUARD_LANE: LANE, GINGA_GUARD: "off", GUARD_DIR: EMPTY }));
    expect(sp.calls.length).toBe(1);
    expect(sp.calls[0].cmd.includes("-e")).toBe(false);
    expect(sp.calls[0].env?.GINGA_GUARD).toBe("off");

    const so = stub();
    const oc = resolveRuntime("opencode", { spawn: so.spawn });
    await oc.run(req({ GINGA_GUARD_LANE: LANE, GINGA_GUARD: "off", GUARD_DIR: EMPTY }));
    expect(so.calls.length).toBe(1);
    expect(so.calls[0].env?.OPENCODE_CONFIG_DIR).toBeUndefined();
  });

  test("sem GINGA_GUARD_LANE (sessão do dono): guard inerte, sem -e e sem GINGA_GUARD no env", async () => {
    const s = stub();
    const adapter = resolveRuntime("pi", { spawn: s.spawn });
    await adapter.run(req({ GUARD_DIR: GUARD }));
    expect(s.calls.length).toBe(1);
    expect(s.calls[0].cmd.includes("-e")).toBe(false);
    expect(s.calls[0].env?.GINGA_GUARD).toBeUndefined();
    expect(s.calls[0].env?.GINGA_GUARD_LOG).toBeUndefined();
  });
});
