import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRuntime } from "../src/runtime/index";

/**
 * RED do PLAN-0034 TASK-01 (congelado): o runtime `pi` do manda liga a guarda de
 * escopo (PLAN-0032) no `pi -p`, só quando a TASK declara `touch`:
 * - a TASK declara o escopo no env do request (derivado do frontmatter pelo
 *   chamador, como GINGA_GUARD_LANE): `MANDA_TASK_TOUCH` / `MANDA_TASK_FROZEN`
 *   (listas JSON, `frozen` opcional);
 * - com touch declarado, o argv ganha `-e <abs>/src/runtime/pi_scope_guard.ts`
 *   (coexiste com o `-e` do guard de segredos, PLAN-0033) e o env do spawn ganha
 *   `MANDA_SCOPE_TOUCH` (JSON), `MANDA_SCOPE_FROZEN` (JSON, padrão `[]`) e
 *   `MANDA_SCOPE_ROOT` (a worktree da TASK = `req.worktree`);
 * - sem `touch` (variável ausente, vazia ou JSON inválido) → não liga: sem `-e`
 *   da guarda e sem `MANDA_SCOPE_*` no env (compatível com TASK antiga);
 * - chave de configuração `[routing] scope_guard = false` no
 *   `<G>/.ginga/project.toml` (G do env do request) desliga a ligação;
 *   padrão (sem chave/arquivo) é `true`.
 */

const ROOT = join(import.meta.dir, "..");
const SCOPE_EXT = join(ROOT, "src", "runtime", "pi_scope_guard.ts");

type Raw = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };
type Call = { cmd: string[]; env?: Record<string, string> };

function stub(raw: Raw = { exitCode: 0, stdout: "", stderr: "" }) {
  const calls: Call[] = [];
  const spawn = async (cmd: string[], o: { env?: Record<string, string> }) => {
    calls.push({ cmd, env: o?.env });
    return raw;
  };
  return { spawn, calls };
}

const TOUCH = ["src/runtime/pi.ts", "tests/runtime_pi_scope.test.ts"];
const FROZEN = ["tests/runtime_pi_scope.test.ts"];

let G_PADRAO: string; // raiz sem project.toml: padrão scope_guard = true
let G_OFF: string; // raiz com [routing] scope_guard = false
let GUARD: string; // checkout "ginga" falso com o guard de segredos instalado
beforeAll(() => {
  G_PADRAO = mkdtempSync(join(tmpdir(), "manda-scope-g-"));
  G_OFF = mkdtempSync(join(tmpdir(), "manda-scope-off-"));
  mkdirSync(join(G_OFF, ".ginga"), { recursive: true });
  writeFileSync(join(G_OFF, ".ginga", "project.toml"), '[routing]\nscope_guard = false\n');
  GUARD = mkdtempSync(join(tmpdir(), "manda-scope-guard-"));
  mkdirSync(join(GUARD, "contrib", "guard"), { recursive: true });
  writeFileSync(join(GUARD, "contrib", "guard", "pi.ts"), "// guard pi\n");
});
afterAll(() => {
  rmSync(G_PADRAO, { recursive: true, force: true });
  rmSync(G_OFF, { recursive: true, force: true });
  rmSync(GUARD, { recursive: true, force: true });
});

const WORKTREE = "/tmp/wt-plan-0034";
const req = (env: Record<string, string>) => ({
  worktree: WORKTREE,
  prompt: "implemente a TASK",
  model: "glm-5.3-flash-free",
  provider: "opencode",
  timeoutMs: 5000,
  env,
});

const withTouch = (extra: Record<string, string> = {}) => ({
  G: G_PADRAO,
  MANDA_TASK_TOUCH: JSON.stringify(TOUCH),
  MANDA_TASK_FROZEN: JSON.stringify(FROZEN),
  ...extra,
});

const extArgs = (cmd: string[]) => cmd.filter((_, i) => cmd[i - 1] === "-e");

describe("guarda de escopo no runtime pi (PLAN-0034 TASK-01)", () => {
  test("com touch declarado: argv leva -e <abs>/pi_scope_guard.ts", async () => {
    const s = stub();
    const adapter = resolveRuntime("pi", { spawn: s.spawn });
    await adapter.run(req(withTouch()));
    expect(s.calls.length).toBe(1);
    expect(extArgs(s.calls[0].cmd)).toContain(SCOPE_EXT);
  });

  test("com touch declarado: env do spawn leva MANDA_SCOPE_TOUCH/FROZEN (JSON) e MANDA_SCOPE_ROOT=worktree", async () => {
    const s = stub();
    const adapter = resolveRuntime("pi", { spawn: s.spawn });
    await adapter.run(req(withTouch()));
    const env = s.calls[0].env ?? {};
    expect(JSON.parse(env.MANDA_SCOPE_TOUCH ?? "")).toEqual(TOUCH);
    expect(JSON.parse(env.MANDA_SCOPE_FROZEN ?? "")).toEqual(FROZEN);
    expect(env.MANDA_SCOPE_ROOT).toBe(WORKTREE);
  });

  test("sem MANDA_TASK_FROZEN: MANDA_SCOPE_FROZEN vira []", async () => {
    const s = stub();
    const adapter = resolveRuntime("pi", { spawn: s.spawn });
    await adapter.run(req({ G: G_PADRAO, MANDA_TASK_TOUCH: JSON.stringify(TOUCH) }));
    const env = s.calls[0].env ?? {};
    expect(JSON.parse(env.MANDA_SCOPE_TOUCH ?? "")).toEqual(TOUCH);
    expect(JSON.parse(env.MANDA_SCOPE_FROZEN ?? "null")).toEqual([]);
    expect(env.MANDA_SCOPE_ROOT).toBe(WORKTREE);
  });

  test("sem touch na TASK (variável ausente): não liga — sem -e da guarda nem MANDA_SCOPE_*", async () => {
    const s = stub();
    const adapter = resolveRuntime("pi", { spawn: s.spawn });
    await adapter.run(req({ G: G_PADRAO }));
    expect(s.calls.length).toBe(1);
    expect(extArgs(s.calls[0].cmd)).not.toContain(SCOPE_EXT);
    const env = s.calls[0].env ?? {};
    expect(env.MANDA_SCOPE_TOUCH).toBeUndefined();
    expect(env.MANDA_SCOPE_FROZEN).toBeUndefined();
    expect(env.MANDA_SCOPE_ROOT).toBeUndefined();
  });

  test("touch vazio ([]) ou JSON inválido: não liga", async () => {
    for (const bad of ["[]", "{invalido"]) {
      const s = stub();
      const adapter = resolveRuntime("pi", { spawn: s.spawn });
      await adapter.run(req({ G: G_PADRAO, MANDA_TASK_TOUCH: bad }));
      expect(extArgs(s.calls[0].cmd)).not.toContain(SCOPE_EXT);
      expect(s.calls[0].env?.MANDA_SCOPE_TOUCH).toBeUndefined();
    }
  });

  test("[routing] scope_guard = false no project.toml desliga mesmo com touch", async () => {
    const s = stub();
    const adapter = resolveRuntime("pi", { spawn: s.spawn });
    await adapter.run(req(withTouch({ G: G_OFF })));
    expect(extArgs(s.calls[0].cmd)).not.toContain(SCOPE_EXT);
    const env = s.calls[0].env ?? {};
    expect(env.MANDA_SCOPE_TOUCH).toBeUndefined();
    expect(env.MANDA_SCOPE_ROOT).toBeUndefined();
  });

  test("coexiste com o -e do guard de segredos (PLAN-0033): dois -e no argv", async () => {
    const s = stub();
    const adapter = resolveRuntime("pi", { spawn: s.spawn });
    await adapter.run(
      req(withTouch({ GINGA_GUARD_LANE: "plan-0034/t321", GUARD_DIR: GUARD })),
    );
    const exts = extArgs(s.calls[0].cmd);
    expect(exts).toContain(SCOPE_EXT);
    expect(exts).toContain(join(GUARD, "contrib", "guard", "pi.ts"));
    expect(s.calls[0].env?.GINGA_GUARD_LANE).toBe("plan-0034/t321");
    expect(JSON.parse(s.calls[0].env?.MANDA_SCOPE_TOUCH ?? "")).toEqual(TOUCH);
  });
});
