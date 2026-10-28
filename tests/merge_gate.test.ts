import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const load = async (rel: string): Promise<any> => import(join(ROOT, rel));

// ---------------------------------------------------------------- fixtures

const REPO_NAME = "fixture";
const BRANCH = "plan/0022";

let repo: string; // trunk (na main)
let wt: string; // worktree em BRANCH
let plan: string; // PLAN dir (com judge/<REPO_NAME>.json, log.md)
let bin: string; // stub de pinga no PATH
let savedPath: string;
const scratch: string[] = [];

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "manda-merge-R-")));
  wt = realpathSync(mkdtempSync(join(tmpdir(), "manda-merge-WT-")));
  plan = realpathSync(mkdtempSync(join(tmpdir(), "manda-merge-PLAN-")));
  bin = realpathSync(mkdtempSync(join(tmpdir(), "manda-merge-BIN-")));
  scratch.push(repo, wt, plan, bin);
  git(["init", "-q", "-b", "main"]);
  put("src/base.ts", "export const base = 1;\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  git(["worktree", "add", "-q", wt, "-b", BRANCH, "main"]);
  put("tasks/T1/PLAN.md", "---\nmode: padrao\ngoal: gate\ntouch: []\ndone_when: 'true'\n---\n", wt);
  git(["add", "."], wt);
  git(["commit", "-q", "-m", "task(T1)"], wt);

  copyFileSync(join(ROOT, "tests/fixtures/merge/pinga-stub"), join(bin, "pinga"));
  chmodSync(join(bin, "pinga"), 0o755);
  savedPath = process.env.PATH ?? "";
  process.env.PATH = `${bin}:${savedPath}`;

  mkdirSync(join(plan, "judge"), { recursive: true });
});

afterEach(() => {
  process.env.PATH = savedPath;
  delete process.env.STUB_QUEUE_FILE;
  delete process.env.STUB_LEDGER_EXIT;
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  scratch.length = 0;
});

function git(args: string[], cwd: string = repo) {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return r.stdout.toString().trim();
}

function put(rel: string, text: string, root = repo) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

function wtHead(): string {
  return git(["rev-parse", "HEAD"], wt);
}

function writeVerdict(head: string, items: unknown[] = []) {
  writeFileSync(
    join(plan, "judge", `${REPO_NAME}.json`),
    JSON.stringify({ head, judge: { verdict: "pass", items, summary: "ok" } }),
  );
}

function stubQueue(tasks: unknown) {
  const f = join(plan, "queue.json");
  writeFileSync(f, JSON.stringify({ tasks }));
  process.env.STUB_QUEUE_FILE = f;
}

async function run() {
  const merge = await load("src/merge.ts");
  return merge.runMerge({ plan, repo, branch: BRANCH, repoName: REPO_NAME });
}

const done = [{ task: "T1", state: "done" }];

// ------------------------------------------------------------------- tests

describe("manda merge: códigos de saída do gate", () => {
  test("10: sem veredito em judge/<repo>.json", async () => {
    stubQueue(done);
    const r = await run();
    expect(r.exitCode).toBe(10);
    expect(git(["rev-parse", "HEAD"])).toBe(git(["rev-parse", "main"]));
  });

  test("10: veredito de outro HEAD não vale", async () => {
    stubQueue(done);
    writeVerdict("0" + wtHead().slice(1));
    const r = await run();
    expect(r.exitCode).toBe(10);
  });

  test("11: item com regression=true barra o merge", async () => {
    stubQueue(done);
    writeVerdict(wtHead(), [{ ref: "AC-01", ok: false, regression: true, evidence: "e" }]);
    const r = await run();
    expect(r.exitCode).toBe(11);
    expect(git(["rev-parse", "HEAD"])).toBe(git(["rev-parse", "main"]));
  });

  test("12: TASK do diff sem receipt done no pinga queue", async () => {
    writeVerdict(wtHead());
    stubQueue([{ task: "T1", state: "open" }]);
    const r = await run();
    expect(r.exitCode).toBe(12);
    expect(r.why).toContain("T1");
    expect(git(["rev-parse", "HEAD"])).toBe(git(["rev-parse", "main"]));
  });

  test("13: falha de teste que a main não tem barra o merge", async () => {
    stubQueue(done);
    put(
      "tests/broken.test.ts",
      'import { test, expect } from "bun:test";\ntest("broken", () => { expect(1).toBe(2); });\n',
      wt,
    );
    git(["add", "."], wt);
    git(["commit", "-q", "-m", "test quebrado"], wt);
    writeVerdict(wtHead()); // veredito sobre o estado final da branch, como o judge real
    const r = await run();
    expect(r.exitCode).toBe(13);
    expect(git(["rev-parse", "HEAD"])).toBe(git(["rev-parse", "main"]));
  });

  test("14: main ganhou falha depois do merge -> revert automático", async () => {
    // a branch comita um teste que precisa de helper.txt; o helper fica só
    // na worktree (untracked), então: branch passa, main pós-merge falha.
    stubQueue(done);
    put(
      "tests/needs_helper.test.ts",
      'import { test, expect } from "bun:test";\nimport { readFileSync } from "node:fs";\ntest("helper", () => {\n  expect(readFileSync("helper.txt", "utf8").trim()).toBe("a");\n});\n',
      wt,
    );
    git(["add", "."], wt);
    git(["commit", "-q", "-m", "teste que precisa de helper"], wt);
    writeVerdict(wtHead()); // veredito sobre o estado final da branch
    put("helper.txt", "a\n", wt); // untracked: não vai no merge
    const r = await run();
    expect(r.exitCode).toBe(14);
    const log = git(["log", "--pretty=%s"]);
    expect(log).toContain("Revert \"Merge");
  });

  test("15: ledger verify falhou -> merge fica, sem revert", async () => {
    process.env.STUB_LEDGER_EXIT = "1";
    stubQueue(done);
    writeVerdict(wtHead());
    const r = await run();
    expect(r.exitCode).toBe(15);
    const parents = git(["log", "-1", "--pretty=%P"]);
    expect(parents.split(" ").length).toBe(2); // merge commit, sem revert
  });

  test("0: mergeado, MERGE_GATE=1 no processo do merge e log no PLAN", async () => {
    stubQueue(done);
    writeVerdict(wtHead());
    const hookDirs = join(repo, ".git", "hooks");
    mkdirSync(hookDirs, { recursive: true });
    writeFileSync(
      join(hookDirs, "pre-merge-commit"),
      `#!/bin/sh\nprintf '%s' "$MERGE_GATE" > '${repo}/gate.env'\n`,
    );
    chmodSync(join(hookDirs, "pre-merge-commit"), 0o755);
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(r.merged).toBe(true);
    expect(readFileSync(join(repo, "gate.env"), "utf8")).toBe("1");
    expect(readFileSync(join(plan, "log.md"), "utf8")).toMatch(/exit 0/);
  });

  test("2: sem worktree para a branch", async () => {
    writeVerdict(wtHead()); // antes da remoção: wtHead() não sobrevive à worktree
    stubQueue(done);
    git(["worktree", "remove", "--force", wt]);
    const r = await run();
    expect(r.exitCode).toBe(2);
  });

  test("2: main com mudanças não commitadas", async () => {
    stubQueue(done);
    writeVerdict(wtHead());
    put("src/base.ts", "export const base = 2;\n");
    const r = await run();
    expect(r.exitCode).toBe(2);
    expect(git(["rev-parse", "HEAD"])).toBe(git(["rev-parse", "main"]));
  });
});

describe("manda merge: CLI", () => {
  test("manda merge <PLAN> <repo> <branch> --json reflete o gate (exit + JSON 1-linha)", async () => {
    stubQueue(done);
    writeVerdict(wtHead());
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m) => logs.push(String(m));
    let code: number;
    try {
      const cli = await load("src/cli.ts");
      code = cli.run(["merge", plan, repo, BRANCH, "--json"]);
    } finally {
      console.log = orig;
    }
    expect(code).toBe(0);
    const out = JSON.parse(logs[0]);
    expect(out.gate).toBe(0);
    expect(out.plan).toBe(basename(plan));
    expect(out.branch).toBe(BRANCH);
    expect(String(out.why).length).toBeGreaterThan(0);
  });
});
