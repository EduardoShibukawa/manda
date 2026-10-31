import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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

function gitRunner(): Runner {
  return (argv, cwd) => {
    const result = Bun.spawnSync(["git", ...argv], { cwd, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode ?? 1, stdout: result.stdout.toString() };
  };
}

/** Cria um repo + plano com uma TASK sem pinga_task e (opcionalmente) um worktree
 *  com tasks/T<ID>/PLAN.md já existente. */
function setupTaken(opts: {
  worktreeHas?: string[];   // ids já alocados no worktree (tasks/T<id>/)
  queueTasks?: string[];    // ids retornados pelo pinga queue
  gingaPingaTask?: string;  // se set, cria uma TASK de ginga com este pinga_task
  createWorktree?: boolean; // se false, não cria a worktree (testa first-execution)
  repoTasks?: string[];     // ids de tasks/T<id>/PLAN.md criados na main (antes do redPlan)
}): { root: string; plan: string } {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "manda-red-taken-")));
  dirs.push(root);

  for (const r of ["manda", "ginga"]) {
    const repoDir = join(root, r);
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, ["init", "-b", "main"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["config", "user.email", "test@test"]);
    writeFileSync(join(repoDir, "README.md"), `# ${r}\n`);
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "-m", "init"]);
  }

  const plan = "PLAN-0042-taken";
  const planDir = join(root, ".ginga", "plans", plan);
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "PLAN.md"), "---\ntype: plan\ntitle: Taken scan\n---\n");

  // TASK de ginga com pinga_task (se informada)
  if (opts.gingaPingaTask) {
    writeFileSync(
      join(planDir, "TASK-01-a.md"),
      `---
type: task
mode: mvp
goal: "ginga task with pinga_task"
title: Tarefa ginga
plan: ${plan}
repo: ginga
depends_on: []
tier: free
touch: [src/b.ts]
done_when: "bun test tests/ginga.test.ts"
tests_frozen: [tests/ginga.test.ts]
pinga_task: ${opts.gingaPingaTask}
---
`,
    );
  }

  // TASK de manda sem pinga_task (precisa alocação)
  const mandaTaskName = opts.gingaPingaTask ? "TASK-02-b" : "TASK-01-a";
  writeFileSync(
    join(planDir, `${mandaTaskName}.md`),
    `---
type: task
mode: mvp
goal: "manda task needs id"
title: Tarefa manda
plan: ${plan}
repo: manda
depends_on: []
tier: free
touch: [src/a.ts]
done_when: "bun test tests/frozen.test.ts"
tests_frozen: [tests/frozen.test.ts]
---
`,
  );

  // frozen files para manda
  const frozen = join(planDir, "frozen", "manda", "tests");
  mkdirSync(frozen, { recursive: true });
  writeFileSync(
    join(frozen, "frozen.test.ts"),
    `import { expect, test } from "bun:test";\ntest("ok", () => expect("red").toBe("green"));\n`,
  );

  // cria tasks/T<id>/PLAN.md na main do manda (antes do redPlan)
  const planSuffix = "0042";
  for (const id of opts.repoTasks ?? []) {
    const taskDir = join(root, "manda", "tasks", id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "PLAN.md"),
      `---
mode: padrao
goal: "existing ${id}"
done_when: "true"
touch: []
tests_frozen: []
---
`,
    );
    git(join(root, "manda"), ["add", "tasks"]);
    git(join(root, "manda"), ["commit", "-m", `existing ${id}`]);
  }

  // cria worktree (a menos que createWorktree seja false — testa first-execution)
  const worktree = join(root, `manda-plan-${planSuffix}`);
  if (opts.createWorktree !== false) {
    git(join(root, "manda"), ["worktree", "add", "-b", `plan/${planSuffix}`, worktree, "main"]);
  }

  for (const id of opts.worktreeHas ?? []) {
    const taskDir = join(worktree, "tasks", id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "PLAN.md"),
      `---
mode: padrao
goal: "existing ${id}"
done_when: "true"
touch: []
tests_frozen: []
---
`,
    );
    git(worktree, ["add", "tasks"]);
    git(worktree, ["commit", "-m", `existing ${id}`]);
  }

  return { root, plan };
}

function makePinga(queueTasks: string[]): Runner {
  return (argv) => {
    if (argv[0] === "queue") {
      const stdout = JSON.stringify({
        tasks: queueTasks.map((t) => ({ task: t, state: "done" })),
      });
      return { code: 0, stdout };
    }
    if (argv[0] === "prove-red") {
      return { code: 0, stdout: "RED provado" };
    }
    return { code: 2, stdout: `comando pinga não suportado: ${argv.join(" ")}` };
  };
}

describe("redPlan taken inclui tasks/T* e todos os pinga_task do bundle", () => {
  test("scan: worktree com tasks/T1/ → id alocado não é T1", () => {
    // worktree já tem tasks/T1/, queue é vazia, bundle tem uma TASK de manda sem pinga_task
    // BUG: taken=[] (queue vazia, nenhum pinga_task no bundle) → allocTaskIds([]) → T1 → COLISÃO
    // FIX: scan tasks/T1/ → taken=[T1] → allocTaskIds([T1]) → T2 → OK
    const { root, plan } = setupTaken({ worktreeHas: ["T1"], queueTasks: [] });
    const result = redPlan({ root, plan, repo: "manda", pinga: makePinga([]), git: gitRunner() });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].pinga_task).not.toBe("T1"); // não pode sobrepor tasks/T1/
    expect(result.tasks[0].pinga_task).toBe("T2"); // max(T1)+1 = T2
  });

  test("bundle multi-repo: TASK de ginga com pinga_task T7 → id alocado para manda não é T7", () => {
    // queue retorna T6, bundle tem ginga(T7) + manda(sem pinga_task)
    // BUG: taken=[T6] (só do queue + tasks do manda, que não tem pinga_task) → allocTaskIds([T6]) → T7 → COLISÃO
    // FIX: taken=[T6, T7] (do queue + TODOS os bundle tasks) → allocTaskIds([T6,T7]) → T8 → OK
    const { root, plan } = setupTaken({ queueTasks: ["T6"], gingaPingaTask: "T7" });
    const result = redPlan({ root, plan, repo: "manda", pinga: makePinga(["T6"]), git: gitRunner() });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].pinga_task).not.toBe("T7"); // não pode sobrepor o T7 do ginga
    expect(result.tasks[0].pinga_task).toBe("T8"); // max(T6,T7)+1 = T8
  });

  test("first execution: worktree não existe, redPlan cria do main com tasks/T1/ → id é T2", () => {
    // First execution: redPlan must create the worktree from main BEFORE building taken.
    // main has tasks/T1/PLAN.md → after worktree creation the scan finds T1.
    // BUG: taken=[] (worktree não criada ainda) → allocTaskIds([]) → T1 → COLISÃO com tasks/T1/ da main.
    // FIX: move worktree creation antes de taken → scan encontra T1 → taken=[T1] → allocTaskIds → T2.
    const { root, plan } = setupTaken({ repoTasks: ["T1"], createWorktree: false, queueTasks: [] });
    const result = redPlan({ root, plan, repo: "manda", pinga: makePinga([]), git: gitRunner() });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].pinga_task).not.toBe("T1"); // não pode sobrepor tasks/T1/ da main
    expect(result.tasks[0].pinga_task).toBe("T2"); // max(T1)+1 = T2
  });
});
