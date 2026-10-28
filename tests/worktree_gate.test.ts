import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");

async function load<T = any>(rel: string): Promise<T | null> {
  try {
    return (await import(join(ROOT, rel))) as T;
  } catch {
    return null;
  }
}

let repo: string;
beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "manda-wt-")));
  git("init", "-q", "-b", "main");
  put("src/base.ts", "export const base = 1;\n");
  put("tests/a.test.ts", "// congelado v1\n");
  put(".gitignore", ".worktrees/\n");
  git("add", ".gitignore", "src", "tests");
  git("commit", "-q", "-m", "init");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function git(...a: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  return r.stdout.toString().trim();
}
function put(rel: string, text: string, root = repo) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

describe("worktree", () => {
  test("createWorktree cria .worktrees/wt-<id> na branch wt/<id>", async () => {
    const wt = await load("src/worktree.ts");
    expect(wt).not.toBeNull();
    const r = await wt!.createWorktree(repo, "t1", "main");
    expect(r.path).toBe(join(repo, ".worktrees", "wt-t1"));
    expect(r.branch).toBe("wt/t1");
    expect(readFileSync(join(r.path, "src/base.ts"), "utf8")).toContain("base = 1");
    expect(git("-C", r.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("wt/t1");
  });

  test("criar duas vezes o mesmo id falha", async () => {
    const wt = await load("src/worktree.ts");
    expect(wt).not.toBeNull();
    await wt!.createWorktree(repo, "t1", "main");
    await expect(wt!.createWorktree(repo, "t1", "main")).rejects.toThrow();
  });

  test("mergeWorktreeToTrunk comita o pendente, faz merge --no-ff e devolve o sha do HEAD", async () => {
    const wt = await load("src/worktree.ts");
    expect(wt).not.toBeNull();
    const { path } = await wt!.createWorktree(repo, "t2", "main");
    put("src/novo.ts", "export const novo = 1;\n", path);
    const r = await wt!.mergeWorktreeToTrunk(repo, "t2", "main");
    expect(readFileSync(join(repo, "src/novo.ts"), "utf8")).toContain("novo = 1");
    expect(r.commitSha).toBe(git("rev-parse", "HEAD"));
    expect(git("rev-list", "--parents", "-n", "1", "HEAD").split(" ").length).toBe(3); // commit de merge: 2 pais
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  test("merge de worktree inexistente falha", async () => {
    const wt = await load("src/worktree.ts");
    expect(wt).not.toBeNull();
    await expect(wt!.mergeWorktreeToTrunk(repo, "nao-existe", "main")).rejects.toThrow();
  });

  test("removeWorktree apaga a pasta e a branch", async () => {
    const wt = await load("src/worktree.ts");
    expect(wt).not.toBeNull();
    const { path } = await wt!.createWorktree(repo, "t3", "main");
    await wt!.removeWorktree(repo, "t3");
    expect(existsSync(path)).toBe(false);
    expect(git("branch", "--list", "wt/t3")).toBe("");
  });
});

describe("gate", () => {
  async function setup(id = "g1") {
    const wt = await load("src/worktree.ts");
    const gate = await load("src/gate.ts");
    expect(wt).not.toBeNull();
    expect(gate).not.toBeNull();
    const { path } = await wt!.createWorktree(repo, id, "main");
    return { gate: gate!, path };
  }
  const base = (path: string, over: Record<string, unknown> = {}) => ({
    task: "PLAN-0001/TASK-01",
    plan: "PLAN-0001",
    repo,
    worktree: path,
    doneWhen: "test -f src/novo.ts",
    base: "main",
    testsFrozen: [] as string[],
    ...over,
  });

  test("sem [commands].verify roda o done_when no worktree", async () => {
    const { gate, path } = await setup();
    put("src/novo.ts", "x\n", path);
    const ok = await gate.runGate(base(path));
    expect(ok.passed).toBe(true);
    expect(ok.command).toBe("test -f src/novo.ts");
    const ko = await gate.runGate(base(path, { doneWhen: "test -f src/ausente.ts" }));
    expect(ko.passed).toBe(false);
    expect(ko.reason).toBe("verify_failed");
    expect(ko.exitCode).not.toBe(0);
  });

  test("com verify, troca {task} {plan} {repo} {worktree} e roda no worktree", async () => {
    const { gate, path } = await setup();
    const r = await gate.runGate(
      base(path, { verify: 'echo "{task}|{plan}|{repo}|{worktree}" > gate.out && pwd >> gate.out', doneWhen: "false" }),
    );
    expect(r.passed).toBe(true);
    const [linha, cwd] = readFileSync(join(path, "gate.out"), "utf8").trim().split("\n");
    expect(linha).toBe(`PLAN-0001/TASK-01|PLAN-0001|${repo}|${path}`);
    expect(realpathSync(cwd!)).toBe(realpathSync(path));
  });

  test("exit do verify é propagado", async () => {
    const { gate, path } = await setup();
    const r = await gate.runGate(base(path, { verify: "exit 3" }));
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.reason).toBe("verify_failed");
  });

  test("tests_frozen alterado: restaura da base, devolve tests_frozen_changed e NÃO roda o gate", async () => {
    const { gate, path } = await setup();
    put("tests/a.test.ts", "// executor mexeu\n", path);
    const marker = join(path, "gate-rodou");
    const r = await gate.runGate(base(path, { testsFrozen: ["tests/a.test.ts"], doneWhen: `touch ${marker}` }));
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("tests_frozen_changed");
    expect(r.restored).toEqual(["tests/a.test.ts"]);
    expect(readFileSync(join(path, "tests/a.test.ts"), "utf8")).toBe("// congelado v1\n");
    expect(existsSync(marker)).toBe(false);
  });

  test("tests_frozen apagado ou já comitado na branch também é detectado e restaurado", async () => {
    const { gate, path } = await setup();
    rmSync(join(path, "tests/a.test.ts"));
    const apagado = await gate.runGate(base(path, { testsFrozen: ["tests/a.test.ts"] }));
    expect(apagado.reason).toBe("tests_frozen_changed");
    expect(readFileSync(join(path, "tests/a.test.ts"), "utf8")).toBe("// congelado v1\n");

    put("tests/a.test.ts", "// mexido e comitado\n", path);
    Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "executor"], { cwd: path });
    const comitado = await gate.runGate(base(path, { testsFrozen: ["tests/a.test.ts"] }));
    expect(comitado.reason).toBe("tests_frozen_changed");
    expect(readFileSync(join(path, "tests/a.test.ts"), "utf8")).toBe("// congelado v1\n");
  });

  test("tests_frozen intacto não atrapalha o gate", async () => {
    const { gate, path } = await setup();
    put("src/novo.ts", "x\n", path);
    const r = await gate.runGate(base(path, { testsFrozen: ["tests/a.test.ts"] }));
    expect(r.passed).toBe(true);
    expect(r.restored ?? []).toEqual([]);
  });

  test("gate.ts não chama o pinga direto", () => {
    const r = Bun.spawnSync(["grep", "-rEn", "pinga", "src/gate.ts", "src/worktree.ts"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(r.stdout.toString().trim()).toBe("");
    expect(existsSync(join(ROOT, "src/gate.ts"))).toBe(true);
  });
});
