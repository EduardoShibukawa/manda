import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * T916 (PLAN-0003, AC-5): num monorepo `repo:` nomeia um pacote — uma pasta
 * de um repositório maior. Uma worktree só para o PLAN; o trabalho fica na
 * pasta do pacote; o gate da TASK só olha arquivos do pacote.
 */
const ROOT = join(import.meta.dir, "..");
const PLAN = "PLAN-0011-x";
let ws: string;
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
const proveArgs: string[][] = [];
function pinga(argv: string[], cwd: string) {
  if (argv[0] === "queue") return { code: 0, stdout: '{"tasks":[]}' };
  if (argv[0] === "prove-red") {
    proveArgs.push([cwd, ...argv]);
    const id = argv[1]!.split("/")[1]!;
    return sh(cwd, "log", "--format=%s", "--", ".").stdout.split("\n").includes(`test(${id}): RED`) ? { code: 0, stdout: "{}" } : { code: 2, stdout: "sem base" };
  }
  return { code: 2, stdout: "?" };
}
const git = (argv: string[], cwd: string) => sh(cwd, ...argv);
const task = (repo: string, what: string) =>
  `---\ntype: task\nmode: mvp\ngoal: "cria ${what}"\nplan: ${PLAN}\nrepo: ${repo}\ndepends_on: []\ntouch: [src/${what}.ts, tests/${what}.test.ts]\ndone_when: "bun test tests/${what}.test.ts"\ntests_frozen: [tests/${what}.test.ts]\n---\ncorpo\n`;

beforeEach(() => {
  proveArgs.length = 0;
  ws = realpathSync(mkdtempSync(join(tmpdir(), "manda-pacote-")));
  scratch.push(ws);
  sh(ws, "init", "-q", "-b", "main");
  put(".gitignore", ".worktrees/\n");
  put("a/package.json", '{"name":"a"}\n');
  put("b/package.json", '{"name":"b"}\n');
  put(`.ginga/plans/${PLAN}/PLAN.md`, "---\ntype: plan\nstatus: approved\n---\n");
  put(`.ginga/plans/${PLAN}/TASK-01-a.md`, task("a", "x"));
  put(`.ginga/plans/${PLAN}/TASK-02-b.md`, task("b", "y"));
  put(`.ginga/plans/${PLAN}/frozen/a/tests/x.test.ts`, "// congelado a\n");
  put(`.ginga/plans/${PLAN}/frozen/b/tests/y.test.ts`, "// congelado b\n");
  sh(ws, "add", ".");
  sh(ws, "commit", "-q", "-m", "base");
});
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  scratch.length = 0;
});

describe("manda red com pacotes de um monorepo", () => {
  test("dois pacotes do mesmo PLAN dividem uma worktree; cada contrato fica na pasta do seu pacote", async () => {
    const { redPlan } = await import(join(ROOT, "src/red.ts"));
    const a = redPlan({ root: ws, plan: PLAN, repo: "a", pinga, git });
    const b = redPlan({ root: ws, plan: PLAN, repo: "b", pinga, git });
    expect(a.tasks).toEqual([{ task: "TASK-01-a", pinga_task: "T1", red: true }]);
    // os ids continuam únicos dentro do bundle (regra do T910), mesmo em pacotes diferentes
    expect(b.tasks).toEqual([{ task: "TASK-02-b", pinga_task: "T2", red: true }]);
    const wt = join(ws, ".worktrees", "plan-0011");
    expect(sh(ws, "worktree", "list").stdout.split("\n").filter((l) => l.includes("[plan/0011]")).length).toBe(1);
    expect(existsSync(join(ws, "a-plan-0011"))).toBe(false);
    expect(existsSync(join(wt, "a", "tasks", "T1", "PLAN.md"))).toBe(true);
    expect(existsSync(join(wt, "b", "tasks", "T2", "PLAN.md"))).toBe(true);
    expect(readFileSync(join(wt, "a", "tests", "x.test.ts"), "utf8")).toBe("// congelado a\n");
    expect(existsSync(join(wt, "tasks"))).toBe(false); // nada na raiz do repositório
    expect(sh(wt, "status", "--porcelain").stdout.trim()).toBe("");
  });

  test("o pinga prova o RED com --root na pasta do pacote", async () => {
    const { redPlan } = await import(join(ROOT, "src/red.ts"));
    redPlan({ root: ws, plan: PLAN, repo: "a", pinga, git });
    const pkgDir = join(ws, ".worktrees", "plan-0011", "a");
    expect(proveArgs).toEqual([[pkgDir, "prove-red", "tasks/T1/PLAN.md", "--root", pkgDir]]);
  });
});

describe("alvos do PLAN", () => {
  test("pacotes do mesmo repositório viram um alvo só (uma branch, um veredito, um merge)", async () => {
    const { planTargets, planRepos } = await import(join(ROOT, "src/bundle.ts"));
    const dir = join(ws, ".ginga", "plans", PLAN);
    expect(planRepos(dir, ws).map((r: { name: string }) => r.name)).toEqual(["a", "b"]);
    expect(planTargets(dir, ws)).toEqual([{ name: basename(ws), path: ws }]);
  });

  test("repos separados continuam um alvo por repo", async () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), "manda-pacote-sep-")));
    scratch.push(outer);
    for (const r of ["a", "b"]) {
      mkdirSync(join(outer, r));
      sh(join(outer, r), "init", "-q", "-b", "main");
    }
    const dir = join(outer, ".ginga", "plans", PLAN);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "PLAN.md"), "---\ntype: plan\n---\n");
    writeFileSync(join(dir, "TASK-01-a.md"), task("a", "x"));
    writeFileSync(join(dir, "TASK-02-b.md"), task("b", "y"));
    const { planTargets } = await import(join(ROOT, "src/bundle.ts"));
    expect(planTargets(dir, outer)).toEqual([
      { name: "a", path: join(outer, "a") },
      { name: "b", path: join(outer, "b") },
    ]);
  });
});

describe("gate da TASK num pacote", () => {
  test("changedPaths devolve só os arquivos do pacote, relativos a ele", async () => {
    const { changedPaths } = await import(join(ROOT, "src/gate.ts"));
    sh(ws, "checkout", "-q", "-b", "trabalho");
    put("a/src/x.ts", "export {};\n");
    put("a/tests/x.test.ts", "// mexido\n");
    sh(ws, "add", ".");
    sh(ws, "commit", "-q", "-m", "a");
    put("a/src/solto.ts", "// sem commit\n");
    put("b/src/outro.ts", "// outro pacote, sem commit\n");
    expect(changedPaths(join(ws, "a"), "main")).toEqual(["src/solto.ts", "src/x.ts", "tests/x.test.ts"]);
  });
});
