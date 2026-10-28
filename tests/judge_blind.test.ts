import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Judge cego (PLAN-0008 TASK-07): `judgePlan` de `src/judge.ts`, com runtime injetado.
 *
 * - `judgePlan({ root, plan, base?, head?, models?, resolveRuntime? })`; `base` padrão `main`,
 *   `head` padrão `HEAD`; `models` como no `manda route` (TASK-03). CLI: `manda judge <PLAN>
 *   [--root D] [--base R] [--head R] [--models D]`.
 * - O runtime do juiz roda com `worktree` = um tmpdir FORA do repo, que contém só:
 *   `SPEC.md` (se o PLAN tem `spec:` e o arquivo existe), `PLAN.md`, `diff.patch` (`git diff base..head`),
 *   `receipts.json` (saída de `[commands].receipts`, padrão `pinga queue --json`) e `metrics.json`
 *   (`{plan, attempts[], cost_usd_total}` montado dos `attempt` do PLAN em `$GINGA_EVENTS`).
 *   Sem repo, sem transcript, sem LEARNINGS. O tmpdir some no fim.
 * - Candidato: 1º de `pools.verifier_judge.default` cuja família ≠ famílias dos `attempt` do PLAN
 *   e ≠ família do Planner (`[runtimes].planner`, `runtime:modelo`). Nenhum candidato → exit 1, sem rodar.
 *   `provider/model` roda no runtime de mesmo nome (`codex`, `agy`, `claude`); outro provider roda no `pi`.
 * - O texto do juiz vira `VERDICT.json` (`{verdict, findings}`) na pasta do PLAN e é selado por
 *   `[commands].judge_seal` com `{plan}` (PLAN.md), `{file}` (VERDICT.json), `{model}` e `{planner}`.
 *   Exit: 0 verdict pass e selo ok; 1 verdict fail ou saída inválida (sem VERDICT.json nem selo); o exit do selo
 *   (7 `same_family_judge`, 8 sem atestado) é propagado.
 */

const ROOT = join(import.meta.dir, "..");
const MODELS = join(import.meta.dir, "fixtures", "models", "primary");
const saved = process.env.GINGA_EVENTS;

let ws: string;
let events: string;
const PLAN = ".ginga/plans/PLAN-0001-x";

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

function attempt(family: string, model: string, cost: number, plan = "PLAN-0001") {
  return JSON.stringify({
    v: 1, ts: "2026-10-28T00:00:00Z", source: "manda", kind: "attempt", id: Math.random().toString(36).slice(2), plan, task: "TASK-01",
    data: { runtime: "pi", model, family, tier: "free", attempt_n: 1, passed: true, duration_ms: 10, tokens_in: 1, tokens_out: 2, cost_usd: cost, cost_source: "metered" },
  });
}

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "manda-judge-")));
  events = join(ws, "..", `events-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.GINGA_EVENTS = events;
  sh(ws, "init", "-q", "-b", "main");
  put(".gitignore", ".worktrees/\n");
  put("src/base.ts", "export const base = 1;\n");
  put(`${PLAN}/PLAN.md`, '---\ntype: plan\ntitle: t\nspec: SPEC-0001-x\nstatus: approved\ndone_when: "true"\n---\nplano de teste\n');
  put(`${PLAN}/TASK-01-t.md`, '---\ntype: task\nmode: mvp\ngoal: "g"\nplan: PLAN-0001-x\ndepends_on: []\ntier: free\ntouch: [src/feature.ts]\ndone_when: "true"\n---\n');
  put(`${PLAN}/LEARNINGS.md`, "segredo do executor\n");
  put(".ginga/specs/SPEC-0001-x.md", "---\ntype: spec\n---\nspec de teste\n");
  put("receipts.json", '[{"task":"T1","status":"pass"}]');
  put(".ginga/models/ROUTING.md", readFileSync(join(MODELS, "ROUTING.md"), "utf8"));
  put(
    ".ginga/project.toml",
    `[routing]\nmodels = ".ginga/models"\n[commands]\nreceipts = "cat ${ws}/receipts.json"\njudge_seal = "printf '%s\\\\n' {plan} {file} {model} {planner} > ${ws}/seal.args"\n[runtimes]\nplanner = "claude:claude-opus-5-5"\n`,
  );
  sh(ws, "add", ".gitignore", ".ginga", "src", "receipts.json");
  sh(ws, "commit", "-q", "-m", "base");
  sh(ws, "checkout", "-q", "-b", "plan/0001");
  put("src/feature.ts", "export const feature = 42;\n");
  sh(ws, "add", "src/feature.ts");
  sh(ws, "commit", "-q", "-m", "feature");
  writeFileSync(events, [attempt("gemini", "gemini-3.8-flash", 0.1), attempt("gemini", "gemini-3.8-flash", 0.2), attempt("qwen", "qwen3.8", 9, "PLAN-0002")].join("\n") + "\n");
});
afterEach(() => {
  if (saved === undefined) delete process.env.GINGA_EVENTS;
  else process.env.GINGA_EVENTS = saved;
  rmSync(ws, { recursive: true, force: true });
  rmSync(events, { force: true });
});

type Req = { worktree: string; model?: string; provider?: string; prompt: string; role?: string };

/** Runtime do juiz: registra a chamada e fotografa o bundle no momento da execução. */
function judgeRuntime(text: string) {
  const calls: Req[] = [];
  let snapshot: { files: string[]; read: (f: string) => string } | null = null;
  const rt = {
    name: "stub",
    family: () => "stub",
    async run(req: Req) {
      calls.push(req);
      const files = readdirSync(req.worktree).sort();
      const cache: Record<string, string> = {};
      for (const f of files) cache[f] = readFileSync(join(req.worktree, f), "utf8");
      snapshot = { files, read: (f) => cache[f] ?? readFileSync(join(req.worktree, f), "utf8") };
      return { passed: true, stdout: "", stderr: "", resultText: text, costUsd: 0, model: req.model };
    },
  };
  return { rt, calls, snap: () => snapshot! };
}

async function judge(rt: unknown, opts: Record<string, unknown> = {}, picked?: string[]) {
  let mod: any = null;
  try {
    mod = await import(join(ROOT, "src/judge.ts"));
  } catch {}
  expect(mod).not.toBeNull();
  return mod.judgePlan({
    root: ws,
    plan: "PLAN-0001",
    base: "main",
    head: "plan/0001",
    resolveRuntime: (name: string) => {
      picked?.push(name);
      return rt;
    },
    ...opts,
  });
}

const PASS = '```json\n{"verdict":"pass","findings":[]}\n```';

describe("bundle cego", () => {
  test("o juiz roda num tmpdir fora do repo com só SPEC, PLAN, diff, receipts e metrics", async () => {
    const j = judgeRuntime(PASS);
    const r = await judge(j.rt);
    expect(r.exitCode).toBe(0);
    expect(j.calls.length).toBe(1);
    const dir = j.calls[0]!.worktree;
    expect(dir.startsWith(ws)).toBe(false);
    expect(j.snap().files).toEqual(["PLAN.md", "SPEC.md", "diff.patch", "metrics.json", "receipts.json"]);
    expect(existsSync(dir)).toBe(false);
  });

  test("conteúdo: PLAN, SPEC, diff base..head, receipts do comando e métricas só do PLAN", async () => {
    const j = judgeRuntime(PASS);
    await judge(j.rt);
    const s = j.snap();
    expect(s.read("PLAN.md")).toContain("plano de teste");
    expect(s.read("SPEC.md")).toContain("spec de teste");
    const diff = s.read("diff.patch");
    expect(diff).toContain("+export const feature = 42;");
    expect(diff).not.toContain("export const base");
    expect(JSON.parse(s.read("receipts.json"))).toEqual([{ task: "T1", status: "pass" }]);
    const m = JSON.parse(s.read("metrics.json"));
    expect(m.attempts.map((a: any) => a.model)).toEqual(["gemini-3.8-flash", "gemini-3.8-flash"]);
    expect(m.cost_usd_total).toBeCloseTo(0.3, 6);
  });

  test("sem LEARNINGS, sem caminho do repo no prompt, sem SPEC quando o PLAN não tem spec:", async () => {
    put(`${PLAN}/PLAN.md`, '---\ntype: plan\ntitle: t\nstatus: approved\ndone_when: "true"\n---\nplano sem spec\n');
    const j = judgeRuntime(PASS);
    await judge(j.rt);
    expect(j.snap().files).toEqual(["PLAN.md", "diff.patch", "metrics.json", "receipts.json"]);
    expect(j.calls[0]!.prompt).not.toContain(ws);
    expect(j.calls[0]!.prompt).not.toContain("LEARNINGS");
    expect(j.calls[0]!.prompt).not.toContain("segredo do executor");
  });
});

describe("família do juiz", () => {
  test("executor gemini + Planner claude → pula o agy/gemini e roda codex/gpt-6-luna", async () => {
    const j = judgeRuntime(PASS);
    const picked: string[] = [];
    await judge(j.rt, {}, picked);
    expect(picked).toEqual(["codex"]);
    expect(j.calls[0]!.model).toBe("gpt-6-luna");
  });

  test("executor deepseek + Planner gemini → o juiz é o 1º que sobra (codex)", async () => {
    writeFileSync(events, attempt("deepseek", "deepseek-v4-pro", 0) + "\n");
    put(".ginga/project.toml", readFileSync(join(ws, ".ginga/project.toml"), "utf8").replace("claude:claude-opus-5-5", "agy:gemini-4-argon"));
    const j = judgeRuntime(PASS);
    const picked: string[] = [];
    await judge(j.rt, {}, picked);
    expect(picked).toEqual(["codex"]);
  });

  test("sem candidato de outra família: exit 1, não roda o juiz e não grava VERDICT", async () => {
    put(".ginga/project.toml", readFileSync(join(ws, ".ginga/project.toml"), "utf8").replace("claude:claude-opus-5-5", "codex:gpt-6-luna"));
    const j = judgeRuntime(PASS);
    const r = await judge(j.rt);
    expect(r.exitCode).toBe(1);
    expect(j.calls.length).toBe(0);
    expect(existsSync(join(ws, PLAN, "VERDICT.json"))).toBe(false);
  });
});

describe("VERDICT e selo", () => {
  test("verdict pass: grava VERDICT.json no PLAN e sela com {plan} {file} {model} {planner}", async () => {
    const j = judgeRuntime(PASS);
    const r = await judge(j.rt);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(ws, PLAN, "VERDICT.json"), "utf8"))).toEqual({ verdict: "pass", findings: [] });
    expect(readFileSync(join(ws, "seal.args"), "utf8").trim().split("\n")).toEqual([
      join(ws, PLAN, "PLAN.md"),
      join(ws, PLAN, "VERDICT.json"),
      "gpt-6-luna",
      "claude-opus-5-5",
    ]);
  });

  test("verdict fail: exit 1, VERDICT.json com os achados e selo chamado", async () => {
    const j = judgeRuntime('{"verdict":"fail","findings":["TASK-01 não cobre o AC"]}');
    const r = await judge(j.rt);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(readFileSync(join(ws, PLAN, "VERDICT.json"), "utf8"))).toEqual({ verdict: "fail", findings: ["TASK-01 não cobre o AC"] });
    expect(existsSync(join(ws, "seal.args"))).toBe(true);
  });

  test("saída que não é veredito: exit 1, sem VERDICT.json e sem selo", async () => {
    const j = judgeRuntime("achei tudo ótimo!");
    const r = await judge(j.rt);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(ws, PLAN, "VERDICT.json"))).toBe(false);
    expect(existsSync(join(ws, "seal.args"))).toBe(false);
  });

  test("o exit do selo é propagado (7 = same_family_judge)", async () => {
    put(".ginga/project.toml", readFileSync(join(ws, ".ginga/project.toml"), "utf8").replace(/judge_seal = .*/, 'judge_seal = "exit 7"'));
    const j = judgeRuntime(PASS);
    const r = await judge(j.rt);
    expect(r.exitCode).toBe(7);
  });
});

describe("manda judge (CLI)", () => {
  function cli(args: string[]) {
    const r = Bun.spawnSync(["bun", join(ROOT, "bin", "manda.ts"), "judge", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, err: r.stderr.toString() };
  }
  test("sem PLAN: uso, exit 2", () => {
    const r = cli([]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Usage: manda judge");
  });
  test("PLAN inexistente: exit 2", () => {
    const r = cli(["PLAN-9999", "--root", ws]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("PLAN-9999");
  });
});
