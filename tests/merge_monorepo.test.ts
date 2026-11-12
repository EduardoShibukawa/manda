import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * T915 (PLAN-0003, AC-4): `manda merge` num monorepo — receipts por pacote e
 * suíte só dos pacotes tocados, cada uma na pasta do pacote.
 */
const ROOT = join(import.meta.dir, "..");
const BRANCH = "plan/0009";
let repo: string;
let wt: string;
let plan: string;
let gateLog: string;
const scratch: string[] = [];

function git(args: string[], cwd: string = repo) {
  return Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
}
function put(rel: string, text: string, root = repo) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
const OK = 'import { test, expect } from "bun:test";\ntest("igual nos dois pacotes", () => { expect(1).toBe(1); });\n';
const BAD = 'import { test, expect } from "bun:test";\ntest("igual nos dois pacotes", () => { expect(1).toBe(2); });\n';
const CONTRACT = "---\nmode: mvp\ngoal: g\ntouch: []\ndone_when: 'true'\n---\n";

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "manda-mono-")));
  const aux = realpathSync(mkdtempSync(join(tmpdir(), "manda-mono-aux-")));
  scratch.push(repo, aux);
  gateLog = join(aux, "gate.log");
  plan = join(repo, ".ginga", "plans", "PLAN-0009-x");
  wt = join(repo, ".worktrees", "plan-0009");
  git(["init", "-q", "-b", "main"]);
  put(".gitignore", ".worktrees/\n");
  // a raiz não tem package.json; os pacotes têm
  put("a/package.json", '{"name":"a"}\n');
  put("a/tests/x.test.ts", OK);
  put("b/package.json", '{"name":"b"}\n');
  put("b/tests/x.test.ts", BAD); // b já falha na main: é falha conhecida, não nova
  put("c/package.json", '{"name":"c"}\n');
  put("c/tests/x.test.ts", OK);
  put(".ginga/project.toml", `[commands]\ngate = "printf '%s|%s\\\\n' {worktree} '{tasks}' >> ${gateLog}"\npost_merge = "none"\n`);
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  git(["worktree", "add", "-q", wt, "-b", BRANCH, "main"]);
  put("a/tasks/T1/PLAN.md", CONTRACT, wt);
  put("a/src/novo.ts", "export {};\n", wt);
  put("b/tasks/T1/PLAN.md", CONTRACT, wt);
  put("b/tasks/T2/PLAN.md", CONTRACT, wt);
  git(["add", "."], wt);
  git(["commit", "-q", "-m", "tasks"], wt);
  mkdirSync(join(plan, "judge"), { recursive: true });
});
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  scratch.length = 0;
});

function verdict() {
  const head = git(["rev-parse", "HEAD"], wt);
  writeFileSync(join(plan, "judge", "x.json"), JSON.stringify({ head, judge: { verdict: "pass", items: [{ ref: "PLAN", ok: true, regression: false, evidence: "e" }], summary: "ok" } }));
}
async function run() {
  verdict();
  const { runMerge } = await import(join(ROOT, "src/merge.ts"));
  return runMerge({ plan, repo, branch: BRANCH, repoName: "x" });
}

describe("manda merge num monorepo", () => {
  test("o gate é chamado por pacote, com a pasta do pacote e só as TASKs dele", async () => {
    const r = await run();
    expect(r.exitCode).toBe(0);
    const lines = readFileSync(gateLog, "utf8").trim().split("\n").sort();
    expect(lines).toEqual([`${join(wt, "a")}|T1`, `${join(wt, "b")}|T1 T2`]);
  });

  test("gate de um pacote recusando barra o merge e nomeia o pacote", async () => {
    put(".ginga/project.toml", `[commands]\ngate = "case {worktree} in */b) exit 12;; esac"\npost_merge = "none"\n`);
    git(["add", "."]);
    git(["commit", "-q", "-m", "gate que recusa b"]);
    const r = await run();
    expect(r.exitCode).toBe(12);
    expect(r.why).toContain("b");
    expect(git(["log", "-1", "--format=%s"])).toBe("gate que recusa b");
  });

  test("falha nova num pacote tocado barra, mesmo com teste de mesmo nome já falhando em outro pacote", async () => {
    put("a/tests/x.test.ts", BAD, wt);
    git(["add", "."], wt);
    git(["commit", "-q", "-m", "quebra a"], wt);
    const r = await run();
    expect(r.exitCode).toBe(13);
    expect(r.why).toContain("[a]");
  });

  test("a suíte de pacote não tocado não roda", async () => {
    // c não é tocado pela branch; se a suíte dele rodasse, este marcador apareceria
    const marker = join(dirname(gateLog), "c-rodou");
    put("c/tests/x.test.ts", `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("marca", () => { writeFileSync(${JSON.stringify(marker)}, "x"); });\n`);
    git(["add", "."]);
    git(["commit", "-q", "-m", "c marca quando roda"]);
    git(["merge", "-q", "main"], wt);
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("mergeado: o trabalho dos pacotes chega na main", async () => {
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(r.merged).toBe(true);
    expect(existsSync(join(repo, "a", "src", "novo.ts"))).toBe(true);
  });
});
