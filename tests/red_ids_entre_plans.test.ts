import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * T910: dois PLANs abertos no mesmo repo não podem receber o mesmo id de
 * TASK. O id alocado para o primeiro só existe na branch dele e no
 * `pinga_task` da TASK no bundle; o red do segundo precisa enxergar isso.
 */
const ROOT = join(import.meta.dir, "..");
let ws: string;
let demo: string;
const scratch: string[] = [];

function sh(cwd: string, ...a: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, stdout: r.stdout.toString() };
}
function put(rel: string, text: string, root = ws) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
function plan(id: string, goal: string, extra: string[] = []) {
  put(`.ginga/plans/${id}/PLAN.md`, "---\ntype: plan\nstatus: approved\n---\n");
  put(
    `.ginga/plans/${id}/TASK-01-a.md`,
    ["---", "type: task", "mode: mvp", `goal: "${goal}"`, `plan: ${id}`, "repo: demo", "depends_on: []", "touch: [src/a.ts]", 'done_when: "true"', ...extra, "---", "corpo"].join("\n") + "\n",
  );
}
const pinga = (argv: string[]) => (argv[0] === "queue" ? { code: 0, stdout: '{"tasks":[]}' } : { code: 0, stdout: "{}" });
const git = (argv: string[], cwd: string) => sh(cwd, ...argv);
async function red(planId: string) {
  const { redPlan } = await import(join(ROOT, "src/red.ts"));
  return redPlan({ root: ws, plan: planId, repo: "demo", pinga, git });
}

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "manda-redids-")));
  scratch.push(ws);
  demo = join(ws, "demo");
  mkdirSync(demo);
  sh(demo, "init", "-q", "-b", "main");
  put("tasks/T1/PLAN.md", '---\nmode: mvp\ngoal: "antiga"\ndone_when: "true"\ntouch: []\n---\n', demo);
  sh(demo, "add", ".");
  sh(demo, "commit", "-q", "-m", "base com T1");
});
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  scratch.length = 0;
});

describe("ids de TASK entre PLANs do mesmo repo", () => {
  test("dois PLANs em sequência, sem merge no meio, ganham T2 e T3", async () => {
    plan("PLAN-0002-b", "cria b");
    plan("PLAN-0003-c", "cria c");
    expect((await red("PLAN-0002-b")).tasks[0].pinga_task).toBe("T2");
    expect((await red("PLAN-0003-c")).tasks[0].pinga_task).toBe("T3");
  });

  test("id já anotado em TASK de outro PLAN do bundle não é reutilizado", async () => {
    plan("PLAN-0002-b", "cria b", ["pinga_task: T7"]);
    plan("PLAN-0003-c", "cria c");
    expect((await red("PLAN-0003-c")).tasks[0].pinga_task).toBe("T8");
  });
});
