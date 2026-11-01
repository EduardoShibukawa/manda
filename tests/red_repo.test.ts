import { afterEach, describe, expect, test } from "bun:test";
import {
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

function setupMultiRepo(): { root: string; plan: string } {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "manda-red-repo-")));
  dirs.push(root);

  for (const repo of ["manda", "ginga"]) {
    const repoDir = join(root, repo);
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, ["init", "-b", "main"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["config", "user.email", "test@test"]);
    writeFileSync(join(repoDir, "README.md"), `# ${repo}\n`);
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "-m", "init"]);
  }

  const plan = "PLAN-0042-multi";
  const planDir = join(root, ".ginga", "plans", plan);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(
    join(planDir, "PLAN.md"),
    `---
type: plan
title: Multi-repo Demo
repos: [manda, ginga]
---
`,
  );

  writeFileSync(
    join(planDir, "TASK-01-a.md"),
    `---
type: task
mode: mvp
goal: "manda task"
title: Tarefa manda
plan: PLAN-0042-multi
repo: manda
depends_on: []
tier: free
touch: [src/a.ts]
done_when: "bun test tests/frozen.test.ts"
tests_frozen: [tests/frozen.test.ts]
---
`,
  );

  writeFileSync(
    join(planDir, "TASK-02-b.md"),
    `---
type: task
mode: mvp
goal: "ginga task"
title: Tarefa ginga
plan: PLAN-0042-multi
repo: ginga
depends_on: []
tier: free
touch: [src/b.ts]
done_when: "bun test tests/ginga.test.ts"
tests_frozen: [tests/ginga.test.ts]
---
`,
  );

  // frozen files for manda
  const frozenManda = join(planDir, "frozen", "manda", "tests");
  mkdirSync(frozenManda, { recursive: true });
  writeFileSync(
    join(frozenManda, "frozen.test.ts"),
    `import { expect, test } from "bun:test";\ntest("manda ok", () => expect("red").toBe("green"));\n`,
  );

  // frozen files for ginga
  const frozenGinga = join(planDir, "frozen", "ginga", "tests");
  mkdirSync(frozenGinga, { recursive: true });
  writeFileSync(
    join(frozenGinga, "ginga.test.ts"),
    `import { expect, test } from "bun:test";\ntest("ginga ok", () => expect("red").toBe("green"));\n`,
  );

  return { root, plan };
}

function setupSingleRepo(withFrozen = true): { root: string; plan: string } {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "manda-red-single-")));
  dirs.push(root);

  const repoDir = join(root, "manda");
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.name", "Test"]);
  git(repoDir, ["config", "user.email", "test@test"]);
  writeFileSync(join(repoDir, "README.md"), "# manda\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-m", "init"]);

  const plan = "PLAN-0043-demo";
  const planDir = join(root, ".ginga", "plans", plan);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "PLAN.md"), `---\ntype: plan\ntitle: Demo\n---\n`);
  writeFileSync(
    join(planDir, "TASK-01-a.md"),
    `---
type: task
mode: mvp
goal: "tarefa de teste"
title: Teste
plan: PLAN-0043-demo
repo: manda
depends_on: []
tier: free
touch: [src/a.ts]
done_when: "bun test tests/frozen.test.ts"
tests_frozen: [tests/frozen.test.ts]
---
`,
  );

  if (withFrozen) {
    const frozen = join(planDir, "frozen", "manda", "tests");
    mkdirSync(frozen, { recursive: true });
    writeFileSync(
      join(frozen, "frozen.test.ts"),
      `import { expect, test } from "bun:test";\ntest("ok", () => expect("red").toBe("green"));\n`,
    );
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
      return {
        code: proofCode,
        stdout: proofCode === 0 ? "RED provado" : "test_passed_on_base",
      };
    }
    return { code: 2, stdout: `comando pinga nao suportado: ${argv.join(" ")}` };
  };
  const gitRunner: Runner = (argv, cwd) => {
    const result = Bun.spawnSync(["git", ...argv], { cwd, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode ?? 1, stdout: result.stdout.toString() };
  };
  return { pinga, git: gitRunner, proveCalls };
}

describe("redPlan multi-repo", () => {
  test("filtra TASKs por repo: so processa TASKs do repo especificado", () => {
    const { root, plan } = setupMultiRepo();
    const { pinga, git: gitRunner, proveCalls } = runners();

    const result = redPlan({ root, plan, repo: "manda", pinga, git: gitRunner });

    // Only the manda task should be processed, not the ginga task
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].task).toBe("TASK-01-a");
    expect(result.tasks[0].red).toBe(true);
    expect(proveCalls).toHaveLength(1);

    const worktree = join(root, "manda-plan-0042");
    expect(existsSync(join(worktree, "tests", "frozen.test.ts"))).toBe(true);
    // ginga worktree should not be created
    expect(existsSync(join(root, "ginga-plan-0042"))).toBe(false);
  });

  test("erro de frozen ausente contem o caminho real do frozen dir", () => {
    const { root, plan } = setupSingleRepo(false);
    const { pinga, git: gitRunner } = runners();

    // frozen/manda does not exist -> error should contain the real frozen path
    expect(() =>
      redPlan({ root, plan, repo: "manda", pinga, git: gitRunner }),
    ).toThrow(/frozen\/manda/);
  });

  test("test_passed_on_base grava status: blocked, nao blocked: true", () => {
    const { root, plan } = setupSingleRepo(true);
    const { pinga, git: gitRunner } = runners(10); // test_passed_on_base

    redPlan({ root, plan, repo: "manda", pinga, git: gitRunner });

    const taskFile = join(root, ".ginga", "plans", plan, "TASK-01-a.md");
    const content = readFileSync(taskFile, "utf8");
    expect(content).toContain("status: blocked");
    expect(content).not.toMatch(/blocked:\s*true/);
  });
});
