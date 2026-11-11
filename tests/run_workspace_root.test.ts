import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * T908: workspace real = raiz com `.ginga/` e os repos dentro. O gate da TASK
 * precisa ler `[commands].verify` da raiz (o repo não tem project.toml), e uma
 * worktree velha da TASK não pode travar a tentativa seguinte.
 */
const ROOT = join(import.meta.dir, "..");
const PLAN = ".ginga/plans/PLAN-0001-x";
const saved = process.env.GINGA_EVENTS;
let ws: string;
let demo: string;
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
const adapter = {
  name: "pi",
  family: () => "stub",
  async run(req: { worktree: string }) {
    put("src/a.ts", "export {};\n", req.worktree);
    return { passed: true, stdout: "", stderr: "", exitCode: 0, costUsd: 0, model: "stub" };
  },
};
async function runPlan() {
  const mod = await import(join(ROOT, "src/run.ts"));
  return mod.runPlan({ root: ws, plan: "PLAN-0001", resolveRuntime: () => adapter });
}

beforeEach(() => {
  delete process.env.GINGA_EVENTS;
  ws = realpathSync(mkdtempSync(join(tmpdir(), "manda-wsroot-")));
  scratch.push(ws);
  demo = join(ws, "demo");
  mkdirSync(demo);
  sh(demo, "init", "-q", "-b", "main");
  put(".gitignore", ".worktrees/\n", demo);
  put("src/base.ts", "export {};\n", demo);
  sh(demo, "add", ".");
  sh(demo, "commit", "-q", "-m", "base");
  put(`${PLAN}/PLAN.md`, '---\ntype: plan\ntitle: t\nstatus: approved\ndone_when: "true"\n---\n');
  put(
    `${PLAN}/TASK-01-a.md`,
    '---\ntype: task\nmode: mvp\ngoal: "cria src/a.ts"\nplan: PLAN-0001-x\nrepo: demo\ndepends_on: []\ntier: free\ntouch: [src/a.ts]\ndone_when: "test -f src/a.ts"\npinga_task: T7\n---\n',
  );
});
afterEach(() => {
  if (saved !== undefined) process.env.GINGA_EVENTS = saved;
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  scratch.length = 0;
});

describe("manda run com project.toml só na raiz do workspace", () => {
  test("[commands].verify da raiz é o gate da TASK de um repo interno", async () => {
    const out = join(ws, "verify.txt");
    put(".ginga/project.toml", `[commands]\nverify = "printf '%s' {gate_id} > ${out}"\n`);
    const r = await runPlan();
    expect(r.exitCode).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("T7");
  });

  test("verify da raiz que falha reprova a TASK", async () => {
    put(".ginga/project.toml", '[commands]\nverify = "false"\n');
    const r = await runPlan();
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(demo, "src/a.ts"))).toBe(false);
  });

  test("project.toml do repo, quando existe, vence o da raiz", async () => {
    put(".ginga/project.toml", '[commands]\nverify = "false"\n');
    put(".ginga/project.toml", '[commands]\nverify = "true"\n', demo);
    sh(demo, "add", ".");
    sh(demo, "commit", "-q", "-m", "config");
    const r = await runPlan();
    expect(r.exitCode).toBe(0);
  });
});

describe("worktree velha da TASK", () => {
  test("tentativa depois de uma falha não morre com 'Worktree já existe'", async () => {
    put(".ginga/project.toml", '[commands]\nverify = "false"\n');
    expect((await runPlan()).exitCode).not.toBe(0);
    put(".ginga/project.toml", '[commands]\nverify = "true"\n');
    const r = await runPlan();
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(demo, "src/a.ts"))).toBe(true);
  });

  test("worktree deixada no disco por uma execução interrompida é substituída", async () => {
    sh(demo, "worktree", "add", "-q", join(demo, ".worktrees", "wt-task-01-a"), "-b", "wt/task-01-a", "main");
    const r = await runPlan();
    expect(r.exitCode).toBe(0);
  });
});
