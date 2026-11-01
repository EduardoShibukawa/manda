import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { watchAttempt } from "../src/attempt_watch";
import { breakerOf, recordFailure } from "../src/breaker";
import { procSampler } from "../src/proc_sample";
import { classifyRun, type RunObs } from "../src/run_state";
import * as runMod from "../src/run";
import { defaultSpawn } from "../src/runtime/port";
import { createOpenCodeRuntime } from "../src/runtime/opencode";

// `realWatchHooks` só existe depois da correção (TASK-13): antes, o teste dela
// falha com "not a function" em vez de erro de import no arquivo inteiro.
const realWatchHooks: any = (runMod as any).realWatchHooks;
const runPlan = runMod.runPlan;

/**
 * RED do achado grave do judge (gate 23:20) no TASK-12 — PLAN-0029 TASK-13:
 * - o sampler real tem de rodar o probe (probe_ok real; null quando não sondado)
 *   para `na_fila` ser alcançável e `travado` exigir probe falha;
 * - `watchAttempt` não pode matar quando o probe diz ok;
 * - o `stop` do fluxo principal não pode abortar o `waitForFree` depois que a
 *   vigia assumiu a falha (onTakeOver);
 * - `stream_bytes`/`since_last_event_s` medem o log do stream da própria
 *   tentativa (`logPath` por tentativa), não o `$GINGA_EVENTS` compartilhado.
 */

const NOW = new Date("2026-10-31T12:00:00.000Z");
const CFG = { patience_min: 5, no_progress_min: 10 };

function tempDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "manda-real-"));
  return new Database(join(dir, "state.db"));
}

function obs(p: Partial<RunObs>): RunObs {
  return {
    since_last_event_s: 0,
    stream_bytes: 100,
    cpu_pct: 50,
    files_changed: true,
    probe_ok: true,
    exit: null,
    stderr_tail: "",
    ...p,
  };
}

const TRAVADO: RunObs = obs({
  since_last_event_s: 700, // > no_progress_min (10 min = 600 s)
  stream_bytes: 50,
  cpu_pct: 0,
  files_changed: false,
  probe_ok: false,
});

const OK: RunObs = obs({ exit: 0 });

function seq(...samples: RunObs[]) {
  let i = 0;
  return async () => samples[Math.min(i++, samples.length - 1)]!;
}

const noSleep = async (_ms: number) => {};

const savedEvents = process.env.GINGA_EVENTS;
const savedStateDb = process.env.GINGA_STATE_DB;
afterEach(() => {
  if (savedEvents === undefined) delete process.env.GINGA_EVENTS;
  else process.env.GINGA_EVENTS = savedEvents;
  if (savedStateDb === undefined) delete process.env.GINGA_STATE_DB;
  else process.env.GINGA_STATE_DB = savedStateDb;
});

describe("procSampler real: probe no lugar certo (TASK-13)", () => {
  test("stream vazio → probe chamado, probe_ok true e classifyRun = na_fila", async () => {
    const dir = mkdtempSync(join(tmpdir(), "manda-sampler-"));
    try {
      const stream = join(dir, "attempt.log");
      writeFileSync(stream, ""); // 0 bytes: conexão aberta, nada chegou
      let probed = 0;
      const sample = procSampler({
        pid: process.pid,
        worktree: dir,
        streamPath: stream,
        startedAt: Date.now(),
        cfg: CFG,
        model: "opencode/f1",
        probe: async (m) => {
          probed++;
          expect(m).toBe("opencode/f1");
          return { ok: true };
        },
      });
      const o = await sample();
      expect(probed).toBe(1);
      expect(o.probe_ok).toBe(true);
      expect(o.stream_bytes).toBe(0);
      expect(classifyRun(o, CFG).state).toBe("na_fila");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stream crescendo com evento recente → probe NÃO chamado e probe_ok null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "manda-sampler-"));
    try {
      const stream = join(dir, "attempt.log");
      writeFileSync(stream, "x".repeat(500));
      let probed = 0;
      const sample = procSampler({
        pid: process.pid,
        worktree: dir,
        streamPath: stream,
        startedAt: Date.now(),
        cfg: CFG,
        model: "opencode/f1",
        probe: async () => {
          probed++;
          return { ok: true };
        },
      });
      const o = await sample();
      expect(probed).toBe(0);
      expect(o.probe_ok).toBeNull();
      expect(o.stream_bytes).toBe(500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("silêncio longo + cpu baixo + sem arquivo → probe chamado; probe falha → travado", async () => {
    const dir = mkdtempSync(join(tmpdir(), "manda-sampler-"));
    try {
      const stream = join(dir, "attempt.log");
      writeFileSync(stream, "x".repeat(50));
      const old = new Date(Date.now() - 20 * 60 * 1000);
      utimesSync(stream, old, old); // último evento há 20 min
      let probed = 0;
      const sample = procSampler({
        pid: process.pid,
        worktree: dir, // não é repo git → files_changed false
        streamPath: stream,
        startedAt: Date.now() - 20 * 60 * 1000,
        cfg: CFG,
        model: "opencode/f1",
        probe: async () => {
          probed++;
          return { ok: false };
        },
      });
      const o = await sample();
      expect(probed).toBe(1);
      expect(o.probe_ok).toBe(false);
      expect(o.since_last_event_s).toBeGreaterThanOrEqual(600);
      expect(classifyRun(o, CFG).state).toBe("travado");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("watchAttempt: probe ok não mata e stop pós-kill não aborta o waitForFree (TASK-13)", () => {
  test("travado com probe ok → sem kill, disjuntor fechado, segue amostrando até ok", async () => {
    const db = tempDb();
    let killed = 0;
    const r = await watchAttempt({
      sample: seq(TRAVADO, TRAVADO, OK),
      kill: () => {
        killed++;
      },
      probe: async () => ({ ok: true }), // modelo saudável, só lento/na fila
      db,
      model: "opencode/f1",
      cfg: CFG,
      sleep: noSleep,
    });
    expect(killed).toBe(0);
    expect(r.outcome).toBe("done");
    expect(breakerOf(db, "opencode/f1", NOW).state).toBe("closed");
  });

  test("travado com probe falha → kill + onTakeOver; stop ligado no kill NÃO aborta o waitForFree", async () => {
    const db = tempDb();
    // Todos os free com disjuntor aberto → pickModel devolve null e cai no waitForFree.
    const free = [
      "opencode/glm-5.3-flash-free",
      "opencode/deepseek-v4.1-flash-free",
      "opencode-go/qwen3.8-flash",
      "opencode-go/deepseek-v4.1-flash",
      "opencode/f1",
    ];
    for (const m of free) recordFailure(db, m, "seed", new Date());

    let killed = 0;
    let tookOver = false;
    let stoppedFlag = false; // simula o run.ts ligando stopWatch quando o run settleia
    const r = await watchAttempt({
      sample: seq(TRAVADO),
      kill: () => {
        killed++;
        stoppedFlag = true;
      },
      probe: async (m) => ({ ok: m === "opencode-go/deepseek-v4.1-flash" }),
      db,
      model: "opencode/f1",
      cfg: CFG,
      sleep: noSleep,
      stop: () => stoppedFlag,
      onTakeOver: () => {
        tookOver = true;
      },
    });
    expect(killed).toBe(1);
    expect(tookOver).toBe(true);
    // O waitForFree tinha de varrer os free e devolver o que passou no probe,
    // mesmo com o stop ligado depois do kill.
    expect(r.outcome).toBe("switched");
    expect(r.next).toBe("opencode-go/deepseek-v4.1-flash");
  });
});

describe("stream da própria tentativa (TASK-13)", () => {
  test("defaultSpawn com logPath grava o stdout do filho no arquivo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "manda-spawn-"));
    try {
      const log = join(dir, "sub", "attempt.log");
      const res = await defaultSpawn(["sh", "-c", "printf hello-stream"], { cwd: dir, logPath: log });
      expect(res.exitCode).toBe(0);
      expect(readFileSync(log, "utf8")).toContain("hello-stream");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("adapter opencode repassa req.logPath ao spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "manda-adapter-"));
    try {
      let seen: { logPath?: string } | null = null;
      const rt = createOpenCodeRuntime({
        spawn: async (_cmd, opts) => {
          seen = opts as { logPath?: string };
          return { exitCode: 0, stdout: "{}", stderr: "" };
        },
      });
      await rt.run({ worktree: dir, prompt: "p", model: "f1", logPath: join(dir, "a.log") });
      expect(seen).not.toBeNull();
      expect(seen!.logPath).toBe(join(dir, "a.log"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("realWatchHooks lê stream_bytes do streamPath da tentativa, não do $GINGA_EVENTS", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "manda-hooks-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "manda-hooks-b-"));
    try {
      const evFile = join(dirA, "events.jsonl");
      writeFileSync(evFile, "x".repeat(100));
      process.env.GINGA_EVENTS = evFile; // log compartilhado, maior
      const stream = join(dirB, "attempt.log");
      writeFileSync(stream, "y".repeat(42));

      const hooks = realWatchHooks({
        root: dirA,
        worktree: dirB,
        cfg: CFG,
        startedAt: Date.now(),
        pidReady: Promise.resolve(process.pid),
        stopped: new Promise<void>(() => {}),
        streamPath: stream,
        model: "opencode/f1",
      });
      const o = await hooks.sample();
      expect(o.stream_bytes).toBe(42);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Integração: runPlan passa logPath por tentativa e o waitForFree da vigia não
// é abortado pelo stopWatch depois do kill (achados do judge no run real).
// ---------------------------------------------------------------------------

let workspace: string;
let eventsFile: string;
let stateDbFile: string;

function git(cwd: string, ...args: string[]): string {
  return Bun.spawnSync(
    ["git", "-c", "user.email=test@example.invalid", "-c", "user.name=test", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  ).stdout.toString().trim();
}

function put(relative: string, content: string): void {
  const path = join(workspace, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function routing(): string {
  return `---
type: policy
title: fixture
ladder:
  - {tier: free, tries: 2}
breaker: {same_reason: 3, ignore: [quota_exhausted, infra]}
pools:
  executor:
    free: [opencode/f1, opencode/f2]
---
fixture
`;
}

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "manda-real-run-")));
  eventsFile = join(workspace, "events.jsonl");
  stateDbFile = join(workspace, "state.db");
  process.env.GINGA_EVENTS = eventsFile;
  process.env.GINGA_STATE_DB = stateDbFile;

  git(workspace, "init", "-q", "-b", "main");
  put(".gitignore", ".worktrees/\n");
  put(".ginga/project.toml", '[routing]\nmodels = ".ginga/models"\n');
  put(".ginga/models/ROUTING.md", routing());
  put(".ginga/plans/PLAN-0029/PLAN.md", "---\ntype: plan\ntitle: fixture\nstatus: approved\n---\n");
  put(
    ".ginga/plans/PLAN-0029/TASK-01.md",
    "---\ntype: task\nmode: mvp\ngoal: fixture\nplan: PLAN-0029\ndepends_on: []\ntier: free\ntouch: [src/a.ts]\ndone_when: \"test -f src/a.ts\"\n---\n",
  );
  put("src/base.ts", "export {};\n");
  git(workspace, "add", ".");
  git(workspace, "commit", "-q", "-m", "fixture");
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("manda run: logPath por tentativa e waitForFree pós-kill (TASK-13)", () => {
  test("request.logPath definido e o attempt da vigia traz next_model (stop não abortou)", async () => {
    // Todos os free com disjuntor aberto: só o waitForFree (probe) acha o próximo.
    const pre = new Database(stateDbFile);
    for (const m of [
      "opencode/f1",
      "opencode/f2",
      "opencode/glm-5.3-flash-free",
      "opencode/deepseek-v4.1-flash-free",
    ]) {
      recordFailure(pre, m, "seed", new Date());
    }
    pre.close();

    const calls: Array<{ model?: string; logPath?: string }> = [];
    let killedPid: number | null = null;
    let resolveKill: () => void = () => {};
    const killed = new Promise<void>((resolve) => {
      resolveKill = resolve;
    });

    const runtime = {
      name: "pi",
      family: () => "stub",
      async run(request: { model?: string; worktree: string; logPath?: string; onPid?: (pid: number) => void }) {
        calls.push({ model: request.model, logPath: request.logPath });
        request.onPid?.(4321);
        if (calls.length === 1) {
          const fallback = new Promise((resolve) =>
            setTimeout(
              () => resolve({ passed: false, failure: "timeout", stdout: "", stderr: "demorou", model: request.model }),
              500,
            ),
          );
          const morto = killed.then(() => ({
            passed: false,
            failure: "infra" as const,
            stdout: "",
            stderr: "killed",
            model: request.model,
          }));
          return (await Promise.race([morto, fallback])) as never;
        }
        writeFileSync(join(request.worktree, "src/a.ts"), "export {};\n");
        return { passed: true, stdout: "", stderr: "", model: request.model };
      },
    };

    const summary = await runPlan({
      root: workspace,
      plan: "PLAN-0029",
      resolveRuntime: () => runtime,
      watch: {
        cfg: CFG,
        sample: async () => TRAVADO,
        probe: async (m: string) => ({ ok: m === "opencode/f2" }),
        kill: (pid: number) => {
          killedPid = pid;
          resolveKill();
        },
        sleep: async () => {},
      },
    } as never);

    // A vigia matou pelo pid exposto pelo onPid.
    expect(killedPid).toBe(4321);
    // Cada tentativa recebe o log do próprio stream (não o $GINGA_EVENTS).
    expect(typeof calls[0]!.logPath).toBe("string");
    expect(calls[0]!.logPath).toContain("TASK-01");
    expect(calls[0]!.logPath!.endsWith(".log")).toBe(true);

    // O waitForFree não foi abortado pelo stopWatch pós-kill: o attempt emitido
    // pela vigia traz o próximo modelo encontrado pelo probe.
    const events = readFileSync(eventsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const watched = events.find((e) => e.kind === "attempt" && e.data?.via === "attempt_watch");
    expect(watched).toBeDefined();
    expect(watched.data.next_model).toBe("opencode/f2");
    expect(summary.exitCode).toBe(1); // f2 tinha disjuntor aberto (seed) → bloqueada
  });
});
