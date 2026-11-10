import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * T907: `manda red` precisa funcionar com a regra real do `pinga prove-red`,
 * que acha a base pelo commit `test(T<N>): RED`. O pinga daqui é um runner
 * que imita só essa regra: sem o commit RED na worktree, sai 2 ("sem base").
 */
const ROOT = join(import.meta.dir, "..");
const PLAN = "PLAN-0042-x";
let ws: string;
let demo: string;
let wt: string;
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

const proveCalls: string[] = [];
/** pinga que só conhece a regra de base do prove-red. */
function pinga(argv: string[], cwd: string) {
  if (argv[0] === "queue") return { code: 0, stdout: '{"tasks":[]}' };
  if (argv[0] === "prove-red") {
    const id = argv[1]!.split("/")[1]!;
    proveCalls.push(id);
    const log = sh(cwd, "log", "--format=%s").stdout;
    if (!log.split("\n").includes(`test(${id}): RED`)) return { code: 2, stdout: `sem base para ${id}` };
    return { code: 0, stdout: "{}" };
  }
  return { code: 2, stdout: "?" };
}
const git = (argv: string[], cwd: string) => sh(cwd, ...argv);

async function red() {
  const { redPlan } = await import(join(ROOT, "src/red.ts"));
  return redPlan({ root: ws, plan: PLAN, repo: "demo", pinga, git });
}

beforeEach(() => {
  proveCalls.length = 0;
  ws = realpathSync(mkdtempSync(join(tmpdir(), "manda-redreal-")));
  scratch.push(ws);
  demo = join(ws, "demo");
  wt = join(ws, "demo-plan-0042");
  mkdirSync(demo);
  sh(demo, "init", "-q", "-b", "main");
  put("src/base.ts", "export {};\n", demo);
  sh(demo, "add", ".");
  sh(demo, "commit", "-q", "-m", "base");
  put(`.ginga/plans/${PLAN}/PLAN.md`, "---\ntype: plan\nstatus: approved\n---\n");
  put(
    `.ginga/plans/${PLAN}/TASK-01-a.md`,
    '---\ntype: task\nmode: mvp\ngoal: "cria a"\nplan: PLAN-0042-x\nrepo: demo\ndepends_on: []\ntouch: [src/a.ts, tests/a.test.ts]\ndone_when: "bun test tests/a.test.ts"\ntests_frozen: [tests/a.test.ts]\n---\ncorpo\n',
  );
  put(`.ginga/plans/${PLAN}/frozen/demo/tests/a.test.ts`, "// congelado\n");
});
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  scratch.length = 0;
});

describe("manda red com a regra de base do pinga", () => {
  test("comita contrato e teste congelado como test(T1): RED antes de provar", async () => {
    const r = await red();
    expect(r.tasks).toEqual([{ task: "TASK-01-a", pinga_task: "T1", red: true }]);
    expect(sh(wt, "log", "--format=%s", "-1").stdout.trim()).toBe("test(T1): RED");
    expect(sh(wt, "status", "--porcelain").stdout.trim()).toBe("");
    expect(sh(wt, "show", "--name-only", "--format=", "HEAD").stdout.trim().split("\n").sort()).toEqual([
      "tasks/T1/PLAN.md",
      "tests/a.test.ts",
    ]);
    expect(readFileSync(join(ws, ".ginga/plans", PLAN, "TASK-01-a.md"), "utf8")).toMatch(/pinga_task: "?T1"?/);
  });

  test("rodar de novo não aloca outro id nem cria outro commit", async () => {
    await red();
    const head = sh(wt, "rev-parse", "HEAD").stdout.trim();
    const again = await red();
    expect(again.tasks.map((t: { pinga_task: string }) => t.pinga_task)).toEqual(["T1"]);
    expect(sh(wt, "rev-parse", "HEAD").stdout.trim()).toBe(head);
    expect(readdirSync(join(wt, "tasks"))).toEqual(["T1"]);
  });

  test("red interrompido (contrato no disco, sem commit nem pinga_task) é retomado no mesmo id", async () => {
    sh(demo, "worktree", "add", "-q", wt, "-b", "plan/0042", "main");
    put("tasks/T1/PLAN.md", '---\nmode: mvp\ngoal: "cria a"\ndone_when: "bun test tests/a.test.ts"\ntouch: ["src/a.ts","tests/a.test.ts"]\ntests_frozen: ["tests/a.test.ts"]\n---\n', wt);
    const r = await red();
    expect(r.tasks).toEqual([{ task: "TASK-01-a", pinga_task: "T1", red: true }]);
    expect(existsSync(join(wt, "tasks", "T2"))).toBe(false);
    expect(proveCalls).toEqual(["T1"]);
  });
});
