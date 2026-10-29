import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
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
  repo = realpathSync(mkdtempSync(join(tmpdir(), "manda-mergehook-R-")));
  wt = realpathSync(mkdtempSync(join(tmpdir(), "manda-mergehook-WT-")));
  plan = realpathSync(mkdtempSync(join(tmpdir(), "manda-mergehook-PLAN-")));
  bin = realpathSync(mkdtempSync(join(tmpdir(), "manda-mergehook-BIN-")));
  scratch.push(repo, wt, plan, bin);
  // trunk
  runGit(["init", "-q", "-b", "main"], repo);
  put("src/base.ts", "export const base = 1;\n", repo);
  runGit(["add", "."], repo);
  runGit(["commit", "-q", "-m", "init"], repo);
  runGit(["worktree", "add", "-q", wt, "-b", BRANCH, "main"], repo);
  put("tasks/T1/PLAN.md", "---\nmode: padrao\ngoal: gate\ntouch: []\ndone_when: 'true'\n---\n", wt);
  runGit(["add", "."], wt);
  runGit(["commit", "-q", "-m", "task(T1)"], wt);

  // install ginga reference-transaction hook (blocks main ref update without MERGE_GATE=1)
  const hooksDir = join(repo, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hook = `#!/bin/sh
blocked=0
while read -r _old _new ref; do
  case "$ref" in
    refs/heads/main) blocked=1 ;;
  esac
done
if [ "$blocked" = 1 ] && [ "$MERGE_GATE" != "1" ]; then
  echo "BLOQUEADO (ginga reference-transaction): update de refs/heads/main sem MERGE_GATE=1" >&2
  exit 1
fi
exit 0
`;
  writeFileSync(join(hooksDir, "reference-transaction"), hook);
  chmodSync(join(hooksDir, "reference-transaction"), 0o755);

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

function runGit(args: string[], cwd: string) {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

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

function writeVerdict(head: string, items: unknown[] = [{ ref: "AC-00", ok: true, regression: false, evidence: "e" }]) {
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

describe("manda merge: revert com hook reference-transaction", () => {
  test("14: merge que piora a main -> revert acontece (exit 14, main de volta) mesmo com hook", async () => {
    stubQueue(done);
    put(
      "tests/needs_helper.test.ts",
      'import { test, expect } from "bun:test";\nimport { readFileSync } from "node:fs";\ntest("helper", () => {\n  expect(readFileSync("helper.txt", "utf8").trim()).toBe("a");\n});\n',
      wt,
    );
    runGit(["add", "."], wt);
    runGit(["commit", "-q", "-m", "teste que precisa de helper"], wt);
    writeVerdict(wtHead());
    put("helper.txt", "a\n", wt); // untracked: não vai no merge
    const mainBefore = git(["rev-parse", "HEAD"]);
    const r = await run();
    expect(r.exitCode).toBe(14);
    const log = git(["log", "--pretty=%s"]);
    expect(log).toContain('Revert "Merge');
    // sanity: main voltou ao estado anterior (revert commit criado)
    expect(git(["rev-parse", "HEAD"])).not.toBe(mainBefore);
  });

});
