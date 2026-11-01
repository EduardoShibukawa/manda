import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { recordFailure } from "../src/breaker";
import { runPlan } from "../src/run";
import type { RunObs } from "../src/run_state";

const savedEvents = process.env.GINGA_EVENTS;
const savedStateDb = process.env.GINGA_STATE_DB;

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
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "manda-watch-live-")));
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
  if (savedEvents === undefined) delete process.env.GINGA_EVENTS;
  else process.env.GINGA_EVENTS = savedEvents;
  if (savedStateDb === undefined) delete process.env.GINGA_STATE_DB;
  else process.env.GINGA_STATE_DB = savedStateDb;
  rmSync(workspace, { recursive: true, force: true });
});

const TRAVADO: RunObs = {
  since_last_event_s: 700, // > no_progress_min (10 min = 600 s)
  stream_bytes: 50,
  cpu_pct: 0,
  files_changed: false,
  probe_ok: false,
  exit: null,
  stderr_tail: "",
};

const OK: RunObs = {
  since_last_event_s: 0,
  stream_bytes: 200,
  cpu_pct: 50,
  files_changed: true,
  probe_ok: true,
  exit: null,
  stderr_tail: "",
};

describe("manda run + vigia ao vivo (PLAN-0029 TASK-12)", () => {
  test("disjuntor aberto pula o modelo no laço de tentativas", async () => {
    const pre = new Database(stateDbFile);
    recordFailure(pre, "opencode/f1", "quota_exhausted", new Date());
    pre.close();

    const calls: string[] = [];
    const runtime = {
      name: "pi",
      family: () => "stub",
      async run(request: { model?: string; worktree: string }) {
        calls.push(request.model ?? "?");
        writeFileSync(join(request.worktree, "src/a.ts"), "export {};\n");
        return { passed: true, stdout: "", stderr: "", model: request.model };
      },
    };

    const summary = await runPlan({
      root: workspace,
      plan: "PLAN-0029",
      resolveRuntime: () => runtime,
    });

    expect(summary.exitCode).toBe(0);
    expect(calls).toEqual(["f2"]);
  });

  test("tentativa travada é morta pelo pid e troca de modelo", async () => {
    const calls: string[] = [];
    let killedPid: number | null = null;
    let resolveKill: () => void = () => {};
    const killed = new Promise<void>((resolve) => {
      resolveKill = resolve;
    });

    const runtime = {
      name: "pi",
      family: () => "stub",
      async run(request: { model?: string; worktree: string; onPid?: (pid: number) => void }) {
        calls.push(request.model ?? "?");
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

    let samples = 0;
    const summary = await runPlan({
      root: workspace,
      plan: "PLAN-0029",
      resolveRuntime: () => runtime,
      watch: {
        cfg: { patience_min: 5, no_progress_min: 10 },
        sample: async () => (samples++ === 0 ? TRAVADO : OK),
        probe: async () => ({ ok: false }),
        kill: (pid: number) => {
          killedPid = pid;
          resolveKill();
        },
        sleep: async () => {},
      },
    } as never);

    expect(summary.exitCode).toBe(0);
    expect(killedPid).toBe(4321);
    expect(calls).toEqual(["f1", "f2"]);

    const db = new Database(stateDbFile);
    try {
      const row = db
        .query("SELECT level FROM model_breaker WHERE model = ?")
        .get("opencode/f1") as { level: number } | null;
      expect(row?.level).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });
});
