import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * RED do PLAN-0033 TASK-09 (congelado; achado grave do judge no TASK-07):
 * o `manda run` real precisa ligar o guard de segredos sozinho —
 * `src/run.ts` deriva `GINGA_GUARD_LANE=<PLAN>/<TASK>` (minúsculas, ex.:
 * `plan-0001/task-01`) quando o processo não trouxe a marca da lane, e
 * preenche `request.env` com `runtimeEnv` (GINGA_GUARD=enforce padrão,
 * GINGA_GUARD_LOG). Com a marca herdada do processo (lane.sh /
 * dispatch-task.sh) ela vence. GINGA_GUARD=off no processo deixa o guard
 * inerte (sessão do dono). Falha fechada de ponta a ponta: guard ligado +
 * GUARD_DIR sem contrib/guard/pi.ts → failure `guard_missing`, spawn não
 * chamado; com o guard presente → argv do pi leva `-e <GUARD_DIR>/contrib/guard/pi.ts`.
 */

const ROOT = join(import.meta.dir, "..");
const ENV_KEYS = ["GINGA_EVENTS", "GINGA_GUARD_LANE", "GINGA_GUARD", "GUARD_DIR"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as Record<string, string | undefined>;

let ws: string;
let events: string;

function sh(cwd: string, ...a: string[]) {
  return Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
    .stdout.toString()
    .trim();
}
function put(rel: string, text: string, root = ws) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "manda-guard-lane-")));
  events = join(ws, "..", `events-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.GINGA_EVENTS = events;
  delete process.env.GINGA_GUARD_LANE;
  delete process.env.GINGA_GUARD;
  delete process.env.GUARD_DIR;
  sh(ws, "init", "-q", "-b", "main");
  put(".gitignore", ".worktrees/\n");
  put("src/base.ts", "export {};\n");
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(ws, { recursive: true, force: true });
  rmSync(events, { force: true });
});

const PLAN = ".ginga/plans/PLAN-0001-x";

function setupPlan() {
  put(
    `${PLAN}/PLAN.md`,
    '---\ntype: plan\ntitle: t\nstatus: approved\ndone_when: "true"\n---\n',
  );
  put(
    `${PLAN}/TASK-01-a.md`,
    [
      "---",
      "type: task",
      "mode: mvp",
      'goal: "goal de TASK-01-a"',
      "plan: PLAN-0001-x",
      "tier: free",
      "touch: [src/a.ts]",
      'done_when: "test -f src/a.ts"',
      "---",
      "corpo",
    ].join("\n") + "\n",
  );
  sh(ws, "add", ".gitignore", ".ginga", "src");
  sh(ws, "commit", "-q", "-m", "init");
}

async function runPlan(opts: Record<string, unknown>) {
  const mod: any = await import(join(ROOT, "src/run.ts"));
  return mod.runPlan({ root: ws, plan: "PLAN-0001", ...opts });
}

type Req = { worktree: string; prompt: string; env?: Record<string, string> };
function stubRuntime(calls: Req[]) {
  return {
    name: "pi",
    family: () => "stub",
    async run(req: Req) {
      calls.push(req);
      put("src/a.ts", "export {};\n", req.worktree);
      return {
        passed: true,
        stdout: "",
        stderr: "",
        model: "stub",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 2 },
        costUsd: 0,
      };
    },
  };
}

describe("manda run deriva a sessão do guard (PLAN-0033 TASK-09)", () => {
  test("request.env traz GINGA_GUARD_LANE=<PLAN>/<TASK> derivado, GINGA_GUARD=enforce e GINGA_GUARD_LOG", async () => {
    setupPlan();
    const calls: Req[] = [];
    const r = await runPlan({ resolveRuntime: () => stubRuntime(calls) });
    expect(r.exitCode).toBe(0);
    expect(calls.length).toBe(1);
    const env = calls[0]!.env;
    expect(env).toBeDefined();
    expect(env!.GINGA_GUARD_LANE).toBe("plan-0001/task-01");
    expect(env!.GINGA_GUARD).toBe("enforce");
    expect(env!.GINGA_GUARD_LOG).toContain("handoffs/guard.events.jsonl");
    const { guardOn } = await import(join(ROOT, "src/runtime/env.ts"));
    expect(guardOn(env!)).toBe(true);
  });

  test("GINGA_GUARD_LANE do processo (lane/dispatch) é herdada, não sobrescrita", async () => {
    setupPlan();
    process.env.GINGA_GUARD_LANE = "PLAN-0033-TASK-07";
    const calls: Req[] = [];
    await runPlan({ resolveRuntime: () => stubRuntime(calls) });
    expect(calls[0]!.env!.GINGA_GUARD_LANE).toBe("PLAN-0033-TASK-07");
  });

  test("GINGA_GUARD=off no processo → guard inerte no request (sessão do dono)", async () => {
    setupPlan();
    process.env.GINGA_GUARD = "off";
    const calls: Req[] = [];
    await runPlan({ resolveRuntime: () => stubRuntime(calls) });
    const { guardOn } = await import(join(ROOT, "src/runtime/env.ts"));
    expect(guardOn(calls[0]!.env!)).toBe(false);
  });

  test("falha fechada no run real: guard ligado + GUARD_DIR sem o guard → guard_missing, spawn não chamado", async () => {
    setupPlan();
    const empty = mkdtempSync(join(tmpdir(), "manda-guard-vazio-"));
    process.env.GUARD_DIR = empty;
    const spawned: string[][] = [];
    const { createPiRuntime } = await import(join(ROOT, "src/runtime/pi.ts"));
    const pi = createPiRuntime({
      bin: "pi",
      spawn: async (cmd: string[]) => {
        spawned.push(cmd);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const r = await runPlan({ resolveRuntime: () => pi });
    expect(r.exitCode).toBe(1);
    expect(r.results[0]!.failure).toBe("guard_missing");
    expect(spawned.length).toBe(0);
    rmSync(empty, { recursive: true, force: true });
  });

  test("guard presente: spawn do pi leva -e <GUARD_DIR>/contrib/guard/pi.ts e env com GINGA_GUARD_LANE derivado", async () => {
    setupPlan();
    const guard = mkdtempSync(join(tmpdir(), "manda-guard-"));
    put("contrib/guard/pi.ts", "// guard pi\n", guard);
    process.env.GUARD_DIR = guard;
    const spawned: { cmd: string[]; env?: Record<string, string> }[] = [];
    const { createPiRuntime } = await import(join(ROOT, "src/runtime/pi.ts"));
    const pi = createPiRuntime({
      bin: "pi",
      spawn: async (cmd: string[], o: { env?: Record<string, string> }) => {
        spawned.push({ cmd, env: o?.env });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await runPlan({ resolveRuntime: () => pi });
    expect(spawned.length).toBe(1);
    const args = spawned[0]!.cmd;
    const i = args.indexOf("-e");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(join(guard, "contrib", "guard", "pi.ts"));
    expect(spawned[0]!.env!.GINGA_GUARD_LANE).toBe("plan-0001/task-01");
    rmSync(guard, { recursive: true, force: true });
  });
});
