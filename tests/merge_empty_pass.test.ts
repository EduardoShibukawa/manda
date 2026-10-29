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

const REPO_NAME = "fixture";
const BRANCH = "plan/0022";

let repo: string;
let wt: string;
let plan: string;
let bin: string;
let savedPath: string;
const scratch: string[] = [];

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "manda-mergeempty-R-")));
  wt = realpathSync(mkdtempSync(join(tmpdir(), "manda-mergeempty-WT-")));
  plan = realpathSync(mkdtempSync(join(tmpdir(), "manda-mergeempty-PLAN-")));
  bin = realpathSync(mkdtempSync(join(tmpdir(), "manda-mergeempty-BIN-")));
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

describe("manda merge: passe vazio (exit 17)", () => {
  test("17: veredito pass com items [] recusa o merge", async () => {
    writeVerdict(wtHead(), []);
    stubQueue([{ task: "T1", state: "done" }]);
    const r = await run();
    expect(r.exitCode).toBe(17);
    expect(r.why).toContain("passe vazio");
    expect(r.merged).toBeUndefined();
  });

  test("17: veredito sem judge.items também é passe vazio", async () => {
    writeFileSync(join(plan, "judge", `${REPO_NAME}.json`), JSON.stringify({ head: wtHead(), judge: { verdict: "pass" } }));
    stubQueue([{ task: "T1", state: "done" }]);
    const r = await run();
    expect(r.exitCode).toBe(17);
  });

  test("com 1 item sem regressão o gate segue (não é 17)", async () => {
    writeVerdict(wtHead(), [{ id: "AC1", ok: true, regression: false }]);
    stubQueue([{ task: "T1", state: "done" }]);
    const r = await run();
    expect(r.exitCode).not.toBe(17);
  });

  test("a ordem do gate: HEAD errado (10) vem antes do passe vazio (17)", async () => {
    writeVerdict("0000000000000000000000000000000000000000", []);
    stubQueue([{ task: "T1", state: "done" }]);
    const r = await run();
    expect(r.exitCode).toBe(10);
  });
});
