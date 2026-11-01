import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runPlan } from "../src/run";

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
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "manda-watch-run-")));
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

describe("manda run + vigia da tentativa", () => {
  test("recusa abre o disjuntor, sucesso fecha e o attempt informa o próximo modelo", async () => {
    const calls: Array<{ model?: string; worktree: string }> = [];
    const runtime = {
      name: "pi",
      family: () => "stub",
      async run(request: { model?: string; worktree: string }) {
        calls.push({ model: request.model, worktree: request.worktree });
        if (calls.length === 1) {
          return {
            passed: false,
            failure: "quota_exhausted" as const,
            stdout: "",
            stderr: "429 usage limit reached",
            model: request.model,
          };
        }
        writeFileSync(join(request.worktree, "src/a.ts"), "export {};\n");
        return {
          passed: true,
          stdout: "",
          stderr: "",
          model: request.model,
        };
      },
    };

    const summary = await runPlan({
      root: workspace,
      plan: "PLAN-0029",
      resolveRuntime: () => runtime,
    });

    expect(summary.exitCode).toBe(0);
    expect(calls.map((call) => call.model)).toEqual(["f1", "f2"]);
    expect(existsSync(stateDbFile)).toBe(true);

    const db = new Database(stateDbFile);
    try {
      const failed = db
        .query("SELECT level FROM model_breaker WHERE model = ?")
        .get("opencode/f1") as { level: number } | null;
      const succeeded = db
        .query("SELECT level FROM model_breaker WHERE model = ?")
        .get("opencode/f2") as { level: number } | null;
      expect(failed?.level).toBe(1);
      expect(succeeded).toBeNull();
    } finally {
      db.close();
    }

    const attempts = readFileSync(eventsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.kind === "attempt");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.data.next_model).toBe("opencode/f2");
  });
});
