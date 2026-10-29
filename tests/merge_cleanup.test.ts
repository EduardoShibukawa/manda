import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
  repo = realpathSync(mkdtempSync(join(tmpdir(), "manda-mergeclean-R-")));
  wt = join(realpathSync(mkdtempSync(join(tmpdir(), "manda-mergeclean-WT-"))), "wt");
  plan = realpathSync(mkdtempSync(join(tmpdir(), "manda-mergeclean-PLAN-")));
  bin = realpathSync(mkdtempSync(join(tmpdir(), "manda-mergeclean-BIN-")));
  scratch.push(repo, dirname(wt), plan, bin);
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

function verdictPass() {
  writeFileSync(
    join(plan, "judge", `${REPO_NAME}.json`),
    JSON.stringify({
      head: git(["rev-parse", "HEAD"], wt),
      judge: { verdict: "pass", items: [{ id: "AC1", ok: true, regression: false }], summary: "ok" },
    }),
  );
  const f = join(plan, "queue.json");
  writeFileSync(f, JSON.stringify({ tasks: [{ task: "T1", state: "done" }] }));
  process.env.STUB_QUEUE_FILE = f;
}

async function run() {
  const merge = await load("src/merge.ts");
  return merge.runMerge({ plan, repo, branch: BRANCH, repoName: REPO_NAME });
}

describe("manda merge: limpeza pós-merge", () => {
  test("exit 0 remove a worktree e apaga a branch", async () => {
    verdictPass();
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(existsSync(wt)).toBe(false);
    expect(git(["worktree", "list", "--porcelain"])).not.toContain(BRANCH);
    expect(git(["branch", "--list", BRANCH])).toBe("");
    // o merge ficou na main
    expect(existsSync(join(repo, "tasks/T1/PLAN.md"))).toBe(true);
  });

  test("WIP sem commit é arquivado como patch no PLAN antes da remoção", async () => {
    verdictPass();
    put("wip-file.txt", "trabalho solto\n", wt);
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(existsSync(wt)).toBe(false);
    const dir = join(plan, "wip");
    expect(existsSync(dir)).toBe(true);
    const patches = readdirSync(dir);
    expect(patches.length).toBe(1);
    expect(readFileSync(join(dir, patches[0]!), "utf8")).toContain("trabalho solto");
  });

  test("sem WIP não cria wip/", async () => {
    verdictPass();
    await run();
    expect(existsSync(join(plan, "wip"))).toBe(false);
  });

  test("exit ≠ 0 não remove a worktree nem a branch", async () => {
    verdictPass();
    process.env.STUB_QUEUE_FILE = join(plan, "queue-vazia.json");
    writeFileSync(process.env.STUB_QUEUE_FILE, JSON.stringify({ tasks: [] }));
    const r = await run();
    expect(r.exitCode).toBe(12);
    expect(existsSync(wt)).toBe(true);
    expect(git(["branch", "--list", BRANCH])).toContain(BRANCH);
  });

  test("exit 15 (ledger falhou, merge fica) também não limpa", async () => {
    verdictPass();
    process.env.STUB_LEDGER_EXIT = "1";
    const r = await run();
    expect(r.exitCode).toBe(15);
    expect(existsSync(wt)).toBe(true);
  });
});
