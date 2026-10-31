import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redPlan, type Runner } from "../src/red.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "red");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString());
  }
  return result.stdout.toString();
}

function setup(withFrozen = true): { root: string; plan: string } {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "manda-red-")));
  dirs.push(root);

  const repo = join(root, "manda");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Manda Test"]);
  git(repo, ["config", "user.email", "manda@example.test"]);
  writeFileSync(join(repo, "README.md"), "# manda\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);

  const plan = "PLAN-0042-demo";
  const planDir = join(root, ".ginga", "plans", plan);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "PLAN.md"), "---\ntype: plan\ntitle: Demo\n---\n");
  copyFileSync(join(FIXTURES, "TASK-01-a.md"), join(planDir, "TASK-01-a.md"));
  copyFileSync(join(FIXTURES, "TASK-02-b.md"), join(planDir, "TASK-02-b.md"));

  if (withFrozen) {
    const frozen = join(planDir, "frozen", "manda");
    mkdirSync(join(frozen, "tests", "fixtures"), { recursive: true });
    copyFileSync(join(FIXTURES, "frozen.test.ts"), join(frozen, "tests", "frozen.test.ts"));
    copyFileSync(join(FIXTURES, "case.txt"), join(frozen, "tests", "fixtures", "case.txt"));
  }
  return { root, plan };
}

function runners(proofCode = 0): { pinga: Runner; git: Runner; proveCalls: string[][] } {
  const proveCalls: string[][] = [];
  const pinga: Runner = (argv) => {
    if (argv[0] === "queue") {
      return { code: 0, stdout: JSON.stringify({ tasks: [{ task: "T7", state: "done" }] }) };
    }
    if (argv[0] === "prove-red") {
      proveCalls.push(argv);
      return { code: proofCode, stdout: proofCode === 0 ? "RED provado" : "test_passed_on_base" };
    }
    return { code: 2, stdout: `comando pinga não suportado: ${argv.join(" ")}` };
  };
  const gitRunner: Runner = (argv, cwd) => {
    const result = Bun.spawnSync(["git", ...argv], { cwd, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode ?? 1, stdout: result.stdout.toString() };
  };
  return { pinga, git: gitRunner, proveCalls };
}

describe("redPlan", () => {
  test("materializa duas TASKs, prova RED e cria um commit por TASK", () => {
    const { root, plan } = setup();
    const { pinga, git: gitRunner, proveCalls } = runners();

    const result = redPlan({ root, plan, repo: "manda", pinga, git: gitRunner });

    expect(result.tasks).toEqual([
      { task: "TASK-01-a", pinga_task: "T8", red: true },
      { task: "TASK-02-b", pinga_task: "T9", red: true },
    ]);
    expect(proveCalls).toHaveLength(2);

    const worktree = join(root, "manda-plan-0042");
    expect(existsSync(join(worktree, "tests", "frozen.test.ts"))).toBe(true);
    expect(existsSync(join(worktree, "tests", "fixtures", "case.txt"))).toBe(true);
    expect(existsSync(join(worktree, "tasks", "T8", "PLAN.md"))).toBe(true);
    expect(existsSync(join(worktree, "tasks", "T9", "PLAN.md"))).toBe(true);
    expect(readFileSync(join(worktree, "tasks", "T8", "PLAN.md"), "utf8")).toContain("bun test tests/frozen.test.ts");
    expect(readFileSync(join(root, ".ginga", "plans", plan, "TASK-01-a.md"), "utf8")).toContain("pinga_task: T8");
    expect(git(worktree, ["branch", "--show-current"]).trim()).toBe("plan/0042");
    expect(git(worktree, ["log", "--format=%s", "main..HEAD"]).trim().split("\n").sort()).toEqual([
      "test(T8): RED",
      "test(T9): RED",
    ]);
  });

  test("não marca RED quando o teste passa na base", () => {
    const { root, plan } = setup();
    const { pinga, git: gitRunner } = runners(10);

    const result = redPlan({ root, plan, repo: "manda", pinga, git: gitRunner });

    expect(result.tasks.map((task) => task.red)).toEqual([false, false]);
    expect(git(join(root, "manda-plan-0042"), ["log", "--format=%s", "main..HEAD"]).trim()).toBe("");
  });

  test("falha com o caminho quando o teste frozen não existe", () => {
    const { root, plan } = setup(false);
    const { pinga, git: gitRunner } = runners();

    expect(() => redPlan({ root, plan, repo: "manda", pinga, git: gitRunner })).toThrow(/tests\/frozen\.test\.ts/);
  });
});
