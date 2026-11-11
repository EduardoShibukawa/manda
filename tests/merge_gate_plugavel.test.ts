import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * T902: `manda merge` não conhece o pinga. O gate de receipts (saída 12) e o
 * pós-merge (saída 15) vêm de `[commands].gate` e `[commands].post_merge` do
 * `.ginga/project.toml`; `pinga gate` / `pinga ledger verify` são só o padrão.
 */
const ROOT = join(import.meta.dir, "..");
const load = async (rel: string): Promise<any> => import(join(ROOT, rel));
const REPO_NAME = "fixture";
const BRANCH = "plan/0902";

let repo: string;
let wt: string;
let plan: string;
let bin: string;
let savedPath: string;
const scratch: string[] = [];

function git(args: string[], cwd: string = repo) {
  return Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    .stdout.toString()
    .trim();
}

function put(rel: string, text: string, root = repo) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

/** `pinga` espião: registra cada chamada em pinga.log e sai com 0. */
function spyPinga() {
  writeFileSync(join(bin, "pinga"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${bin}/pinga.log"\nexit 0\n`);
  chmodSync(join(bin, "pinga"), 0o755);
}

function pingaCalls(): string {
  return existsSync(join(bin, "pinga.log")) ? readFileSync(join(bin, "pinga.log"), "utf8") : "";
}

function commands(lines: string[], root = repo) {
  put(".ginga/project.toml", ["[commands]", ...lines, ""].join("\n"), root);
}

function verdict() {
  writeFileSync(
    join(plan, "judge", `${REPO_NAME}.json`),
    JSON.stringify({ head: git(["rev-parse", "HEAD"], wt), judge: { verdict: "pass", items: [{ ref: "AC-00", ok: true, regression: false, evidence: "e" }], summary: "ok" } }),
  );
}

async function run() {
  return (await load("src/merge.ts")).runMerge({ plan, repo, branch: BRANCH, repoName: REPO_NAME });
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "manda-gatep-R-")));
  wt = realpathSync(mkdtempSync(join(tmpdir(), "manda-gatep-WT-")));
  plan = realpathSync(mkdtempSync(join(tmpdir(), "manda-gatep-PLAN-")));
  bin = realpathSync(mkdtempSync(join(tmpdir(), "manda-gatep-BIN-")));
  scratch.push(repo, wt, plan, bin);
  git(["init", "-q", "-b", "main"]);
  put("src/base.ts", "export const base = 1;\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  git(["worktree", "add", "-q", wt, "-b", BRANCH, "main"]);
  put("tasks/T1/PLAN.md", "---\nmode: padrao\ngoal: gate\ntouch: []\ndone_when: 'true'\n---\n", wt);
  put("tasks/T2/PLAN.md", "---\nmode: padrao\ngoal: gate\ntouch: []\ndone_when: 'true'\n---\n", wt);
  git(["add", "."], wt);
  git(["commit", "-q", "-m", "task(T1,T2)"], wt);
  spyPinga();
  savedPath = process.env.PATH ?? "";
  process.env.PATH = `${bin}:${savedPath}`;
  mkdirSync(join(plan, "judge"), { recursive: true });
  verdict();
});

afterEach(() => {
  process.env.PATH = savedPath;
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  scratch.length = 0;
});

describe("manda merge: gate e pós-merge plugáveis", () => {
  test("gate e post_merge configurados: mergeia sem chamar o pinga", async () => {
    commands(['gate = "true"', 'post_merge = "true"']);
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(pingaCalls()).toBe("");
  });

  test("gate que falha → 12 e a main não anda", async () => {
    commands(['gate = "false"', 'post_merge = "true"']);
    const before = git(["rev-parse", "main"]);
    const r = await run();
    expect(r.exitCode).toBe(12);
    expect(git(["rev-parse", "main"])).toBe(before);
  });

  test("o gate recebe {tasks}, {worktree}, {repo} e {plan}", async () => {
    const out = join(bin, "gate-args.txt");
    commands([`gate = "printf '%s|' {tasks} {worktree} {repo} {plan} > ${out}"`, 'post_merge = "true"']);
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(`T1|T2|${wt}|${repo}|${plan}|`);
  });

  test("o JSON do gate com `pending` entra no motivo da recusa", async () => {
    commands([`gate = "echo '{\\"ok\\":false,\\"pending\\":[\\"T2\\"]}'; exit 12"`, 'post_merge = "true"']);
    const r = await run();
    expect(r.exitCode).toBe(12);
    expect(r.why).toContain("T2");
  });

  test("post_merge que falha → 15 e o merge fica", async () => {
    commands(['gate = "true"', 'post_merge = "false"']);
    const before = git(["rev-parse", "main"]);
    const r = await run();
    expect(r.exitCode).toBe(15);
    expect(git(["rev-parse", "main"])).not.toBe(before);
  });

  test('"none" desliga os dois passos', async () => {
    commands(['gate = "none"', 'post_merge = "none"']);
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(pingaCalls()).toBe("");
  });

  test("sem config, o padrão é `pinga gate` e `pinga ledger verify`", async () => {
    const r = await run();
    expect(r.exitCode).toBe(0);
    const calls = pingaCalls().trim().split("\n");
    expect(calls[0]).toBe(`gate --root ${wt} T1 T2`);
    expect(calls[1]).toBe("ledger verify");
  });

  test("comando de gate que não existe falha fechado (12)", async () => {
    commands(['gate = "comando-que-nao-existe-902 {tasks}"', 'post_merge = "true"']);
    const r = await run();
    expect(r.exitCode).toBe(12);
  });

  test("sem project.toml no trunk, vale o do bundle do PLAN", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "manda-gatep-ROOT-")));
    scratch.push(root);
    const bundlePlan = join(root, ".ginga", "plans", "PLAN-0902");
    mkdirSync(join(bundlePlan, "judge"), { recursive: true });
    commands(['gate = "false"'], root);
    plan = bundlePlan;
    verdict();
    const r = await run();
    expect(r.exitCode).toBe(12);
  });
});
