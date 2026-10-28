import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const load = async (rel: string): Promise<any> => import(join(ROOT, rel));

let repo: string;
beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "manda-gatefix-")));
  git("init", "-q", "-b", "main");
  put("src/base.ts", "export const base = 1;\n");
  put(".gitignore", ".worktrees/\n");
  put(".ginga/project.toml", '[commands]\nverify = "exit 7"\n');
  git("add", ".");
  git("commit", "-q", "-m", "init");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function git(...a: string[]) {
  return Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo, stdout: "pipe", stderr: "pipe" })
    .stdout.toString().trim();
}
function put(rel: string, text: string, root = repo) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
async function setup(id = "f1") {
  const wt = await load("src/worktree.ts");
  const gate = await load("src/gate.ts");
  const { path } = await wt.createWorktree(repo, id, "main");
  return { gate, path };
}
const input = (path: string, over: Record<string, unknown> = {}) => ({
  task: "PLAN-0001/TASK-01", plan: "PLAN-0001", repo, worktree: path,
  doneWhen: "true", base: "main", testsFrozen: [] as string[], ...over,
});

describe("tests_frozen ausente na base", () => {
  test("arquivo congelado criado pelo executor: falha com tests_frozen_changed, remove o arquivo e não roda o gate", async () => {
    const { gate, path } = await setup();
    put("tests/novo_frozen.test.ts", "// criado pelo executor\n", path);
    const r = await gate.runGate(input(path, { testsFrozen: ["tests/novo_frozen.test.ts"], verify: "touch gate.ran" }));
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("tests_frozen_changed");
    expect(r.restored).toContain("tests/novo_frozen.test.ts");
    expect(existsSync(join(path, "tests/novo_frozen.test.ts"))).toBe(false);
    expect(existsSync(join(path, "gate.ran"))).toBe(false);
  });
});

describe("config do verify", () => {
  test("[commands].verify vem do repo (trunk), não da worktree que o executor pode editar", async () => {
    const { gate, path } = await setup("f2");
    put(".ginga/project.toml", '[commands]\nverify = "true"\n', path);
    const r = await gate.runGate(input(path, { doneWhen: "true" }));
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(7);
    expect(r.command).toBe("exit 7");
  });
});
