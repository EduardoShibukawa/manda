import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * T906: as peças do condutor falam a mesma língua. O judge cego grava
 * `judge/<repo>.json` (com `head`) que o `manda merge` lê; o merge recusa
 * veredito `fail`; `manda red|merge <PLAN>` cobrem os repos do PLAN.
 * Layout do workspace real: raiz com `.ginga/` e os repos como subpastas.
 */
const ROOT = join(import.meta.dir, "..");
const MODELS = join(import.meta.dir, "fixtures", "models", "primary");
const PLAN = ".ginga/plans/PLAN-0001-x";
const savedEvents = process.env.GINGA_EVENTS;
const savedPath = process.env.PATH ?? "";

let ws: string;
let demo: string;
let planWt: string;
let events: string;
let bin: string;
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

function planBranch() {
  sh(demo, "worktree", "add", "-q", planWt, "-b", "plan/0001", "main");
  put("src/feature.ts", "export const feature = 42;\n", planWt);
  sh(planWt, "add", ".");
  sh(planWt, "commit", "-q", "-m", "feature");
}

type Req = { worktree: string; model?: string };
function judgeRuntime(text: string) {
  const calls: Req[] = [];
  let diff = "";
  return {
    calls,
    diff: () => diff,
    rt: {
      name: "stub",
      family: () => "stub",
      async run(req: Req) {
        calls.push(req);
        diff = readFileSync(join(req.worktree, "diff.patch"), "utf8");
        return { passed: true, stdout: "", stderr: "", resultText: text, costUsd: 0, model: req.model };
      },
    },
  };
}

async function judge(rt: unknown) {
  const mod = await import(join(ROOT, "src/judge.ts"));
  return mod.judgePlan({ root: ws, plan: "PLAN-0001", resolveRuntime: () => rt });
}
const verdictFile = () => JSON.parse(readFileSync(join(ws, PLAN, "judge", "demo.json"), "utf8"));

function manda(...args: string[]) {
  return Bun.spawnSync([process.execPath, join(ROOT, "bin/manda.ts"), ...args], {
    cwd: ws,
    env: { ...process.env, PATH: `${bin}:${savedPath}` },
    stdout: "pipe",
    stderr: "pipe",
  });
}

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "manda-cond-")));
  bin = realpathSync(mkdtempSync(join(tmpdir(), "manda-cond-BIN-")));
  demo = join(ws, "demo");
  planWt = join(ws, "demo-plan-0001");
  events = join(bin, "events.jsonl");
  scratch.push(ws, bin);
  process.env.GINGA_EVENTS = events;
  mkdirSync(demo, { recursive: true });
  sh(demo, "init", "-q", "-b", "main");
  put("src/base.ts", "export const base = 1;\n", demo);
  sh(demo, "add", ".");
  sh(demo, "commit", "-q", "-m", "base");
  put(`${PLAN}/PLAN.md`, '---\ntype: plan\ntitle: t\nstatus: approved\ndone_when: "true"\n---\nplano de teste\n');
  put(
    `${PLAN}/TASK-01-t.md`,
    '---\ntype: task\nmode: mvp\ngoal: "g"\nplan: PLAN-0001-x\nrepo: demo\ndepends_on: []\ntier: free\ntouch: [src/feature.ts]\ndone_when: "true"\n---\n',
  );
  put(".ginga/models/ROUTING.md", readFileSync(join(MODELS, "ROUTING.md"), "utf8"));
  put(
    ".ginga/project.toml",
    '[routing]\nmodels = ".ginga/models"\n[commands]\nreceipts = "echo []"\njudge_seal = "none"\ngate = "none"\npost_merge = "none"\n[runtimes]\nplanner = "claude:claude-opus-5-5"\n',
  );
  writeFileSync(
    events,
    JSON.stringify({ v: 1, ts: "2026-11-10T00:00:00Z", source: "manda", kind: "attempt", id: "a1", plan: "PLAN-0001", task: "TASK-01", data: { runtime: "pi", model: "gemini-3.8-flash", family: "gemini", passed: true, cost_usd: 0 } }) + "\n",
  );
  // pinga de mentira para o `manda red`: fila vazia e prove-red ok
  writeFileSync(join(bin, "pinga"), '#!/bin/sh\ncase "$1" in queue) echo \'{"tasks":[]}\';; esac\nexit 0\n');
  chmodSync(join(bin, "pinga"), 0o755);
});
afterEach(() => {
  if (savedEvents === undefined) delete process.env.GINGA_EVENTS;
  else process.env.GINGA_EVENTS = savedEvents;
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  scratch.length = 0;
});

describe("judge cego por repo do PLAN", () => {
  test("pass: grava judge/demo.json com o HEAD da branch do PLAN e um item sem regressão", async () => {
    planBranch();
    const j = judgeRuntime('{"verdict":"pass","findings":[]}');
    const r = await judge(j.rt);
    expect(r.exitCode).toBe(0);
    const v = verdictFile();
    expect(v.head).toBe(sh(planWt, "rev-parse", "HEAD"));
    expect(v.judge.verdict).toBe("pass");
    expect(v.judge.items.length).toBe(1);
    expect(v.judge.items[0].regression).toBe(false);
    expect(j.diff()).toContain("+export const feature = 42;");
    expect(j.diff()).not.toContain("export const base");
  });

  test("fail: exit 1 e o veredito fail fica gravado com os achados", async () => {
    planBranch();
    const r = await judge(judgeRuntime('{"verdict":"fail","findings":["AC-02 não coberto"]}').rt);
    expect(r.exitCode).toBe(1);
    const v = verdictFile();
    expect(v.judge.verdict).toBe("fail");
    expect(v.judge.items[0].ok).toBe(false);
    expect(v.judge.items[0].evidence).toContain("AC-02 não coberto");
  });

  test("um veredito por HEAD: a segunda chamada reaproveita e não chama o juiz", async () => {
    planBranch();
    const j = judgeRuntime('{"verdict":"pass","findings":[]}');
    await judge(j.rt);
    const r = await judge(j.rt);
    expect(r.exitCode).toBe(0);
    expect(j.calls.length).toBe(1);
  });
});

describe("manda merge", () => {
  test("veredito fail é recusado com saída 11", async () => {
    planBranch();
    await judge(judgeRuntime('{"verdict":"fail","findings":["x"]}').rt);
    const before = sh(demo, "rev-parse", "main");
    const merge = await import(join(ROOT, "src/merge.ts"));
    const r = merge.runMerge({ plan: join(ws, PLAN), repo: demo, branch: "plan/0001", repoName: "demo" });
    expect(r.exitCode).toBe(11);
    expect(sh(demo, "rev-parse", "main")).toBe(before);
  });

  test("manda merge <PLAN> --root: mergeia a branch do PLAN em cada repo dele", async () => {
    planBranch();
    await judge(judgeRuntime('{"verdict":"pass","findings":[]}').rt);
    const r = manda("merge", "PLAN-0001", "--root", ws);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(demo, "src/feature.ts"))).toBe(true);
  });

  test("manda merge <PLAN> sem branch do PLAN em nenhum repo sai 2", () => {
    expect(manda("merge", "PLAN-0001", "--root", ws).exitCode).toBe(2);
  });
});

describe("manda red <PLAN> sem --repo", () => {
  test("cria a worktree da branch do PLAN em cada repo e anota o pinga_task", () => {
    const r = manda("red", "PLAN-0001", "--root", ws);
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    expect(existsSync(planWt)).toBe(true);
    expect(sh(planWt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("plan/0001");
    expect(readFileSync(join(ws, PLAN, "TASK-01-t.md"), "utf8")).toMatch(/pinga_task: "?T1"?/);
  });
});
