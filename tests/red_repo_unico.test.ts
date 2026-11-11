import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * T914: workspace de repo único — a raiz é o repo, o `.ginga/` vive dentro
 * dele e as TASKs não trazem `repo:`. O `manda red` tem que materializá-las.
 */
const ROOT = join(import.meta.dir, "..");
const PLAN = "PLAN-0007-x";
let ws: string;
const scratch: string[] = [];

function sh(cwd: string, ...a: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, stdout: r.stdout.toString() };
}
function put(rel: string, text: string) {
  const p = join(ws, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
function pinga(argv: string[], cwd: string) {
  if (argv[0] === "queue") return { code: 0, stdout: '{"tasks":[]}' };
  if (argv[0] === "prove-red") {
    const id = argv[1]!.split("/")[1]!;
    return sh(cwd, "log", "--format=%s").stdout.split("\n").includes(`test(${id}): RED`) ? { code: 0, stdout: "{}" } : { code: 2, stdout: "sem base" };
  }
  return { code: 2, stdout: "?" };
}
const git = (argv: string[], cwd: string) => sh(cwd, ...argv);
const task = (extra = "") =>
  `---\ntype: task\nmode: mvp\ngoal: "cria a"\nplan: ${PLAN}\n${extra}depends_on: []\ntouch: [src/a.ts, tests/a.test.ts]\ndone_when: "bun test tests/a.test.ts"\ntests_frozen: [tests/a.test.ts]\n---\ncorpo\n`;

async function red() {
  const { redPlan } = await import(join(ROOT, "src/red.ts"));
  const { planRepos } = await import(join(ROOT, "src/bundle.ts"));
  const repos = planRepos(join(ws, ".ginga", "plans", PLAN), ws);
  return { repos, out: redPlan({ root: ws, plan: PLAN, repo: repos[0]!.name, pinga, git }) };
}

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "manda-repo-unico-")));
  scratch.push(ws);
  sh(ws, "init", "-q", "-b", "main");
  put(".gitignore", ".worktrees/\n");
  put("src/base.ts", "export {};\n");
  put(`.ginga/plans/${PLAN}/PLAN.md`, "---\ntype: plan\nstatus: approved\n---\n");
  put(`.ginga/plans/${PLAN}/TASK-01-a.md`, task());
  put(`.ginga/plans/${PLAN}/frozen/tests/a.test.ts`, "// congelado\n");
  sh(ws, "add", ".");
  sh(ws, "commit", "-q", "-m", "base");
});
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  scratch.length = 0;
});

describe("manda red num workspace de repo único", () => {
  test("TASK sem repo: é do repo da raiz e ganha contrato, teste congelado e commit RED", async () => {
    const { repos, out } = await red();
    expect(repos).toEqual([{ name: basename(ws), path: ws }]);
    expect(out.tasks).toEqual([{ task: "TASK-01-a", pinga_task: "T1", red: true }]);
    const wt = join(ws, ".worktrees", "plan-0007");
    expect(existsSync(join(wt, "tasks", "T1", "PLAN.md"))).toBe(true);
    expect(readFileSync(join(wt, "tests", "a.test.ts"), "utf8")).toBe("// congelado\n");
    expect(sh(wt, "log", "--format=%s", "-1").stdout.trim()).toBe("test(T1): RED");
    expect(readFileSync(join(ws, ".ginga/plans", PLAN, "TASK-01-a.md"), "utf8")).toMatch(/pinga_task: "?T1"?/);
  });

  test("a worktree fica em .worktrees/, não solta na raiz do repo", async () => {
    await red();
    expect(sh(ws, "worktree", "list").stdout).toContain(join(ws, ".worktrees", "plan-0007"));
    expect(existsSync(join(ws, `${basename(ws)}-plan-0007`))).toBe(false);
    // nada novo aparece como arquivo não rastreado além do que o projeto já ignora
    expect(sh(ws, "status", "--porcelain", "--untracked-files=all").stdout).not.toContain("plan-0007");
  });

  test("frozen/<nome do repo>/ continua valendo quando existe", async () => {
    rmSync(join(ws, ".ginga/plans", PLAN, "frozen"), { recursive: true });
    put(`.ginga/plans/${PLAN}/frozen/${basename(ws)}/tests/a.test.ts`, "// pelo nome\n");
    await red();
    expect(readFileSync(join(ws, ".worktrees", "plan-0007", "tests", "a.test.ts"), "utf8")).toBe("// pelo nome\n");
  });

  test("TASK de outro repo não entra no repo da raiz", async () => {
    put(`.ginga/plans/${PLAN}/TASK-02-b.md`, task("repo: outro\n").replace("cria a", "cria b"));
    const { redPlan } = await import(join(ROOT, "src/red.ts"));
    const out = redPlan({ root: ws, plan: PLAN, repo: basename(ws), pinga, git });
    expect(out.tasks.map((t: { task: string }) => t.task)).toEqual(["TASK-01-a"]);
  });
});
