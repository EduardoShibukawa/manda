import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * T914: num repo único o bundle `.ginga/` é arquivo do próprio trunk. O red
 * anota `pinga_task` na TASK e o tick grava o log; isso não é mudança
 * pendente do código e não pode barrar o merge. Fora do `.ginga/`, barra.
 */
const ROOT = join(import.meta.dir, "..");
const BRANCH = "plan/0007";
let repo: string;
let wt: string;
let plan: string;
let bin: string;
let savedPath: string;
const scratch: string[] = [];

function git(args: string[], cwd: string = repo) {
  return Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
}
function put(rel: string, text: string, root = repo) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "manda-trunk-")));
  bin = realpathSync(mkdtempSync(join(tmpdir(), "manda-trunk-bin-")));
  scratch.push(repo, bin);
  plan = join(repo, ".ginga", "plans", "PLAN-0007-x");
  wt = join(repo, ".worktrees", "plan-0007");
  git(["init", "-q", "-b", "main"]);
  put(".gitignore", ".worktrees/\n");
  put("src/base.ts", "export const base = 1;\n");
  put(".ginga/plans/PLAN-0007-x/TASK-01-a.md", "---\ntype: task\n---\n");
  put(".ginga/plans/PLAN-0007-x/log.md", "# log\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  git(["worktree", "add", "-q", wt, "-b", BRANCH, "main"]);
  put("tasks/T1/PLAN.md", "---\nmode: mvp\ngoal: g\ntouch: []\ndone_when: 'true'\n---\n", wt);
  git(["add", "."], wt);
  git(["commit", "-q", "-m", "task(T1)"], wt);
  copyFileSync(join(ROOT, "tests/fixtures/merge/pinga-stub"), join(bin, "pinga"));
  chmodSync(join(bin, "pinga"), 0o755);
  savedPath = process.env.PATH ?? "";
  process.env.PATH = `${bin}:${savedPath}`;
  mkdirSync(join(plan, "judge"), { recursive: true });
  const head = git(["rev-parse", "HEAD"], wt);
  writeFileSync(join(plan, "judge", "x.json"), JSON.stringify({ head, judge: { verdict: "pass", items: [{ ref: "PLAN", ok: true, regression: false, evidence: "e" }], summary: "ok" } }));
  const q = join(bin, "queue.json");
  writeFileSync(q, JSON.stringify({ tasks: [{ task: "T1", state: "done" }] }));
  process.env.STUB_QUEUE_FILE = q;
});
afterEach(() => {
  process.env.PATH = savedPath;
  delete process.env.STUB_QUEUE_FILE;
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  scratch.length = 0;
});

async function run() {
  const { runMerge } = await import(join(ROOT, "src/merge.ts"));
  return runMerge({ plan, repo, branch: BRANCH, repoName: "x" });
}

test("bundle .ginga/ alterado no trunk não barra o merge", async () => {
  // o que o red e o tick fazem no bundle durante o PLAN
  put(".ginga/plans/PLAN-0007-x/TASK-01-a.md", '---\ntype: task\npinga_task: "T1"\n---\n');
  put(".ginga/plans/PLAN-0007-x/log.md", "# log\n- tick\n");
  const r = await run();
  expect(r.exitCode).toBe(0);
  expect(r.merged).toBe(true);
});

test("mudança de código fora do .ginga/ continua barrando", async () => {
  put("src/base.ts", "export const base = 2;\n");
  const r = await run();
  expect(r.exitCode).toBe(2);
  expect(r.why).toContain("nao commitadas");
});
