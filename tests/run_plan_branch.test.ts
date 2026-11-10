import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * T905: com a branch do PLAN (`plan/NNNN`, criada pelo `manda red`) presente,
 * o `manda run` parte dela e devolve o trabalho para ela. A main só anda pelo
 * `manda merge`. Sem a branch, o comportamento antigo (merge na main) continua.
 */
const ROOT = join(import.meta.dir, "..");
const saved = process.env.GINGA_EVENTS;
const PLAN = ".ginga/plans/PLAN-0001-x";

let ws: string;
let planWt: string;
const scratch: string[] = [];

function sh(cwd: string, ...a: string[]) {
  return Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, stdout: "pipe", stderr: "pipe" })
    .stdout.toString()
    .trim();
}
function put(rel: string, text: string, root = ws) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

function setup(o: { toml?: string; pingaTask?: string } = {}) {
  put(`${PLAN}/PLAN.md`, '---\ntype: plan\ntitle: t\nstatus: approved\ndone_when: "true"\n---\n');
  put(
    `${PLAN}/TASK-01-a.md`,
    [
      "---",
      "type: task",
      "mode: mvp",
      'goal: "cria src/a.ts"',
      "plan: PLAN-0001-x",
      "depends_on: []",
      "tier: free",
      "touch: [src/a.ts]",
      'done_when: "test -f src/a.ts"',
      ...(o.pingaTask ? [`pinga_task: ${o.pingaTask}`] : []),
      "---",
      "corpo",
    ].join("\n") + "\n",
  );
  if (o.toml !== undefined) put(".ginga/project.toml", o.toml);
  sh(ws, "add", ".gitignore", ".ginga", "src");
  sh(ws, "commit", "-q", "-m", "init");
}

/** Worktree da branch do PLAN, com um commit RED que a main não tem. */
function planBranch() {
  planWt = `${ws}-plan-0001`;
  scratch.push(planWt);
  sh(ws, "worktree", "add", "-q", planWt, "-b", "plan/0001", "main");
  put("tests/red.test.ts", "// RED do planner\n", planWt);
  sh(planWt, "add", ".");
  sh(planWt, "commit", "-q", "-m", "test(T7): RED");
}

type Req = { worktree: string };
function runtime(behavior: (req: Req) => void) {
  const calls: Req[] = [];
  return {
    calls,
    adapter: {
      name: "pi",
      family: () => "stub",
      async run(req: Req) {
        calls.push(req);
        behavior(req);
        return { passed: true, stdout: "", stderr: "", exitCode: 0, costUsd: 0, model: "stub" };
      },
    },
  };
}

async function runPlan(rt: { adapter: unknown }) {
  const mod = await import(join(ROOT, "src/run.ts"));
  return mod.runPlan({ root: ws, plan: "PLAN-0001", resolveRuntime: () => rt.adapter });
}

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "manda-planbr-")));
  scratch.push(ws);
  delete process.env.GINGA_EVENTS;
  sh(ws, "init", "-q", "-b", "main");
  put(".gitignore", ".worktrees/\n");
  put("src/base.ts", "export {};\n");
});
afterEach(() => {
  if (saved !== undefined) process.env.GINGA_EVENTS = saved;
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  scratch.length = 0;
});

describe("manda run na branch do PLAN", () => {
  test("com plan/0001: o trabalho entra na branch do PLAN e a main não anda", async () => {
    setup();
    planBranch();
    const mainBefore = sh(ws, "rev-parse", "main");
    const rt = runtime((req) => put("src/a.ts", "export {};\n", req.worktree));
    const r = await runPlan(rt);
    expect(r.exitCode).toBe(0);
    expect(sh(ws, "rev-parse", "main")).toBe(mainBefore);
    expect(existsSync(join(ws, "src/a.ts"))).toBe(false);
    expect(existsSync(join(planWt, "src/a.ts"))).toBe(true);
    expect(sh(planWt, "status", "--porcelain")).toBe("");
    expect(sh(ws, "log", "--oneline", "main..plan/0001")).toContain("task-01-a");
  });

  test("a worktree da TASK nasce da branch do PLAN (vê o commit RED)", async () => {
    setup();
    planBranch();
    let sawRed = false;
    const rt = runtime((req) => {
      sawRed = existsSync(join(req.worktree, "tests/red.test.ts"));
      put("src/a.ts", "export {};\n", req.worktree);
    });
    await runPlan(rt);
    expect(sawRed).toBe(true);
    expect(rt.calls[0]!.worktree).not.toBe(planWt);
    expect(existsSync(rt.calls[0]!.worktree)).toBe(false);
  });

  test("sem branch do PLAN: comportamento antigo, o trabalho chega na main", async () => {
    setup();
    const rt = runtime((req) => put("src/a.ts", "export {};\n", req.worktree));
    const r = await runPlan(rt);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(ws, "src/a.ts"))).toBe(true);
  });

  test("{gate_id} (o pinga_task do frontmatter da TASK) chega ao [commands].verify", async () => {
    setup({ toml: '[commands]\nverify = "test {gate_id} = T7 && test -f src/a.ts"\n', pingaTask: "T7" });
    planBranch();
    const rt = runtime((req) => put("src/a.ts", "export {};\n", req.worktree));
    const r = await runPlan(rt);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(planWt, "src/a.ts"))).toBe(true);
  });

  test("gate que falha na branch do PLAN não mergeia nada", async () => {
    setup({ toml: '[commands]\nverify = "false"\n' });
    planBranch();
    const before = sh(ws, "rev-parse", "plan/0001");
    const rt = runtime((req) => put("src/a.ts", "export {};\n", req.worktree));
    const r = await runPlan(rt);
    expect(r.exitCode).not.toBe(0);
    expect(sh(ws, "rev-parse", "plan/0001")).toBe(before);
  });
});
