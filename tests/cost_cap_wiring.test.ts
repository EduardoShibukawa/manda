import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(import.meta.dir, "fixtures", "opencode-cost.sql");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "manda-cap-")));
  dirs.push(d);
  return d;
}
function put(root: string, rel: string, text: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

// Import dinámico: no base os named exports novos não existem e a falha tem de ser por asserção.
let cap: any;
beforeAll(async () => {
  cap = await import(join(ROOT, "src", "cost_cap.ts"));
});

const costCmd = (spent: number) => ["bun", "-e", `console.log(JSON.stringify({ spent_usd: ${spent} }))`];

function fixtureDb(): string {
  const dir = tmp();
  const path = join(dir, "opencode.db");
  const db = new Database(path, { create: true });
  for (const statement of readFileSync(FIXTURE, "utf8").split(";")) {
    const sql = statement.trim();
    if (sql) db.run(sql);
  }
  db.close();
  return path;
}

describe("loadRoundCapUsd", () => {
  test("lê [budget] round_usd do .ginga/project.toml", () => {
    expect(typeof cap.loadRoundCapUsd).toBe("function");
    const root = tmp();
    put(root, ".ginga/project.toml", "[budget]\nround_usd = 1.50\n");
    expect(cap.loadRoundCapUsd(root)).toBe(1.5);
  });

  test("sem [budget] round_usd → Infinity (sem teto, sem TOTAL_CAP de ambiente)", () => {
    const root = tmp();
    put(root, ".ginga/project.toml", "[supervisor]\nidle_cooldown_ms = 1\n");
    expect(cap.loadRoundCapUsd(root)).toBe(Infinity);
  });
});

describe("isPaidModel", () => {
  test("free: prefixo pi: e sufixos -free/:free", () => {
    expect(typeof cap.isPaidModel).toBe("function");
    expect(cap.isPaidModel("opencode/glm-5.3-flash-free")).toBe(false);
    expect(cap.isPaidModel("pi:openrouter/x:free")).toBe(false);
    expect(cap.isPaidModel("pi:nvidia/model")).toBe(false);
  });

  test("pago: sem marca de free (inclusive undefined)", () => {
    expect(cap.isPaidModel("opencode/deepseek-v4-pro")).toBe(true);
    expect(cap.isPaidModel(undefined)).toBe(true);
  });
});

describe("checkPaidCall", () => {
  test("usa o custo do costCmd (ginga cost --json) e nega acima do teto", () => {
    expect(typeof cap.checkPaidCall).toBe("function");
    const root = tmp();
    put(root, ".ginga/project.toml", "[budget]\nround_usd = 1.00\n");
    const r = cap.checkPaidCall({
      root,
      since: "2026-01-01T00:00:00.000Z",
      next_estimate_usd: 0.3,
      model: "opencode/deepseek-v4-pro",
      costCmd: costCmd(0.9),
    });
    expect(r.allow).toBe(false);
  });

  test("modelo free não é barrado pelo teto", () => {
    const root = tmp();
    put(root, ".ginga/project.toml", "[budget]\nround_usd = 0.01\n");
    const r = cap.checkPaidCall({
      root,
      since: "2026-01-01T00:00:00.000Z",
      next_estimate_usd: 99,
      model: "opencode/glm-5.3-flash-free",
      costCmd: costCmd(50),
    });
    expect(r.allow).toBe(true);
  });

  test("costCmd falho → fallback spentUsd (opencode.db fixture + claude)", () => {
    const root = tmp();
    put(root, ".ginga/project.toml", "[budget]\nround_usd = 1.00\n");
    const r = cap.checkPaidCall({
      root,
      since: "2026-01-01T00:00:00.000Z",
      next_estimate_usd: 0.3,
      model: "opencode/deepseek-v4-pro",
      opencodeDb: fixtureDb(),
      claudeCosts: [0.4],
      costCmd: ["definitely-not-a-real-command-xyz"],
    });
    // fixture: 0.35 no db desde 2026-01-01 + 0.40 claude = 0.75; 0.75 + 0.30 > 1.00 → nega
    expect(r.allow).toBe(false);
  });
});

// ---------- integração: runPlan barra a chamada paga antes do adapter ----------

const saved = process.env.GINGA_EVENTS;
let ws: string;
let events: string;

function sh(cwd: string, ...a: string[]) {
  return Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, stdout: "pipe", stderr: "pipe" })
    .stdout.toString()
    .trim();
}
function putWs(rel: string, text: string) {
  put(ws, rel, text);
}

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "manda-caprun-")));
  dirs.push(ws);
  events = join(ws, "..", `events-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.GINGA_EVENTS = events;
  sh(ws, "init", "-q", "-b", "main");
  putWs(".gitignore", ".worktrees/\n");
  putWs("src/base.ts", "export {};\n");
  const PLAN = ".ginga/plans/PLAN-0001-x";
  putWs(`${PLAN}/PLAN.md`, '---\ntype: plan\ntitle: t\nstatus: approved\ndone_when: "true"\n---\n');
  putWs(
    `${PLAN}/TASK-01-a.md`,
    [
      "---",
      "type: task",
      "mode: mvp",
      'goal: "goal"',
      "plan: PLAN-0001-x",
      "depends_on: []",
      "tier: free",
      "touch: [src/a.ts]",
      'done_when: "test -f src/a.ts"',
      "---",
      "corpo",
    ].join("\n") + "\n",
  );
});
afterEach(() => {
  if (saved === undefined) delete process.env.GINGA_EVENTS;
  else process.env.GINGA_EVENTS = saved;
  rmSync(events, { force: true });
});

type Req = { worktree: string; prompt: string; model?: string; role?: string };
function stubRuntime(name: string, files: string[]) {
  const calls: Req[] = [];
  return {
    name,
    calls,
    family: () => "stub",
    async run(req: Req) {
      calls.push(req);
      for (const f of files) put(req.worktree, f, "export {};\n");
      return { passed: true, stdout: "", stderr: "", exitCode: 0, model: req.model };
    },
  };
}

async function runPlan(opts: Record<string, unknown>) {
  const mod: any = await import(join(ROOT, "src", "run.ts"));
  return mod.runPlan({ root: ws, plan: "PLAN-0001", ...opts });
}

describe("run.ts: chamada paga barrada antes do adapter", () => {
  test("round_usd estourado → adapter.run não é chamado e a TASK falha", async () => {
    putWs(".ginga/project.toml", '[runtimes]\nexecutor = "opencode:paid-pro"\n[budget]\nround_usd = 1.00\n');
    sh(ws, "add", ".");
    sh(ws, "commit", "-q", "-m", "init");
    const oc = stubRuntime("opencode", ["src/a.ts"]);
    const r = await runPlan({ resolveRuntime: () => oc, costCmd: costCmd(0.9), nextEstimateUsd: 0.3 });
    expect(oc.calls.length).toBe(0);
    expect(r.results[0]?.passed).toBe(false);
  });

  test("dentro do teto → adapter é chamado e a TASK passa", async () => {
    putWs(".ginga/project.toml", '[runtimes]\nexecutor = "opencode:paid-pro"\n[budget]\nround_usd = 1.00\n');
    sh(ws, "add", ".");
    sh(ws, "commit", "-q", "-m", "init");
    const oc = stubRuntime("opencode", ["src/a.ts"]);
    const r = await runPlan({ resolveRuntime: () => oc, costCmd: costCmd(0.1), nextEstimateUsd: 0.3 });
    expect(oc.calls.length).toBe(1);
    expect(r.results[0]?.passed).toBe(true);
  });
});
