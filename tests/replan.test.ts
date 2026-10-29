import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReplanContext, replan, type Runner } from "../src/replan.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function put(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

function setup(): { root: string; plan: string; task: string } {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "manda-replan-")));
  dirs.push(root);
  const plan = "PLAN-0042-demo";
  const task = "TASK-03-replan";
  const planDir = join(root, ".ginga", "plans", plan);
  put(join(planDir, "PLAN.md"), "---\ntype: plan\ntitle: Demo\n---\n");
  put(join(planDir, `${task}.md`), "---\ntype: task\ngoal: corrigir a tarefa\n---\ncorpo da tarefa\n");
  put(join(planDir, "LEARNINGS.md"), "- learning estável\n");
  put(join(root, "diff-main-plan.txt"), "diff --git a/x b/x\n");
  put(join(root, "diff-main-plan-stat.txt"), " x | 1 +\n");
  return { root, plan, task };
}

describe("buildReplanContext", () => {
  test("monta TASK, receipts, judge, diff e learnings de forma determinística", () => {
    const { root, plan, task } = setup();
    const options = {
      root,
      plan,
      task,
      receipts: [
        { seq: 1, reason_code: "primeiro" },
        { seq: 2, reason_code: "segundo" },
        { seq: 3, reason_code: "terceiro" },
        { seq: 4, reason_code: "quarto" },
      ],
      judge: "achado alto",
      diff: "diff completo",
    };

    const first = buildReplanContext(options);
    expect(first).toBe(buildReplanContext(options));
    expect(first).toContain("corpo da tarefa");
    expect(first).toContain("segundo");
    expect(first).toContain("terceiro");
    expect(first).toContain("quarto");
    expect(first).not.toContain("primeiro");
    expect(first).toContain("achado alto");
    expect(first).toContain("diff completo");
    expect(first).toContain("learning estável");
  });

  test("trunca o diff em 20000 caracteres", () => {
    const { root, plan, task } = setup();
    const context = buildReplanContext({
      root,
      plan,
      task,
      receipts: [],
      judge: "",
      diff: "x".repeat(20_050),
    });
    expect(context).toContain("x".repeat(20_000));
    expect(context).not.toContain("x".repeat(20_001));
  });
});

describe("replan", () => {
  test("chama o Planner com o contexto e aceita o PLAN quando o lint passa", () => {
    const { root, plan, task } = setup();
    const calls: Array<{ argv: string[]; cwd: string }> = [];
    const planner: Runner = (argv, cwd) => {
      calls.push({ argv, cwd });
      return { code: 0, stdout: "PLAN reescrito" };
    };
    const lint: Runner = (argv, cwd) => {
      calls.push({ argv, cwd });
      return { code: 0, stdout: "ok" };
    };

    const result = replan({ root, plan, task, receipts: [], judge: "", diff: "", planner, lint });

    expect(result).toEqual({ result: "replanned", reason: "lint ok" });
    expect(calls[0]?.argv.join(" ")).toContain("replan.md");
    expect(calls[0]?.argv.join(" ")).toContain("TASK-03-replan");
    expect(calls[1]?.argv.join(" ")).toContain("lint");
  });

  test("bloqueia quando o Planner deixa o PLAN inválido", () => {
    const { root, plan, task } = setup();
    const planner: Runner = () => ({ code: 0, stdout: "PLAN quebrado" });
    const lint: Runner = () => ({ code: 1, stdout: "frontmatter inválido" });

    const result = replan({ root, plan, task, receipts: [], judge: "", diff: "", planner, lint });

    expect(result).toEqual({ result: "blocked", reason: "frontmatter inválido" });
  });
});
