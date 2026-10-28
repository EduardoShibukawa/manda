import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Escada de tiers + breaker (PLAN-0008 TASK-04), exercitada por `runPlan` com runtime injetado.
 *
 * A escada vem do ROUTING.md apontado por `[routing].models` do project.toml
 * (TASK-03): `ladder` free×2 → medium×2; `strong` só com `tier: strong` explícito e `pools.executor.<tier>`.
 * - Cada tentativa usa o 1º candidato do tier ainda não tentado; sem candidato novo
 *   no tier, sobe para o próximo (candidato já tentado é pulado).
 * - A TASK começa no tier dela.
 * - Breaker: 3 falhas seguidas com o mesmo `failure` param tudo; `quota_exhausted` e `infra` não contam.
 * - Esgotou ou breaker: `transition` task → `blocked` (não `failed`) + evento `blocker` (`raised_by: manda`).
 * - `[runtimes]` fixado no projeto ignora a escada, e sem pasta de modelos há uma tentativa só.
 */

const ROOT = join(import.meta.dir, "..");
const saved = process.env.GINGA_EVENTS;

let ws: string;
let events: string;

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

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "manda-esc-")));
  events = join(ws, "..", `events-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.GINGA_EVENTS = events;
  sh(ws, "init", "-q", "-b", "main");
  put(".gitignore", ".worktrees/\n");
  put("src/base.ts", "export {};\n");
});
afterEach(() => {
  if (saved === undefined) delete process.env.GINGA_EVENTS;
  else process.env.GINGA_EVENTS = saved;
  rmSync(ws, { recursive: true, force: true });
  rmSync(events, { force: true });
});

const PLAN = ".ginga/plans/PLAN-0001-x";

const ROUTING = (free: string[]) => `---
type: policy
title: fixture
ladder:
  - {tier: free, tries: 2}
  - {tier: medium, tries: 2}
  - {tier: strong, tries: 1}
breaker: {same_reason: 3, ignore: [quota_exhausted, infra]}
pools:
  executor:
    free: [${free.join(", ")}]
    medium: [opencode/m1, opencode/m2]
    strong: [opencode/s1]
---
fixture
`;

function setup(o: { tiers?: string[]; free?: string[]; toml?: string | null } = {}) {
  put(`${PLAN}/PLAN.md`, '---\ntype: plan\ntitle: t\nstatus: approved\ndone_when: "true"\n---\n');
  const tiers = o.tiers ?? ["free"];
  tiers.forEach((tier, i) => {
    const name = `TASK-0${i + 1}-t`;
    put(
      `${PLAN}/${name}.md`,
      [
        "---",
        "type: task",
        "mode: mvp",
        `goal: "goal de ${name}"`,
        "plan: PLAN-0001-x",
        `depends_on: [${i === 0 ? "" : `TASK-0${i}-t`}]`,
        `tier: ${tier}`,
        `touch: [src/a${i + 1}.ts]`,
        `done_when: "test -f src/a${i + 1}.ts"`,
        "---",
        "corpo",
      ].join("\n") + "\n",
    );
  });
  put(".ginga/models/ROUTING.md", ROUTING(o.free ?? ["opencode/f1", "opencode/f2"]));
  const toml = o.toml === undefined ? '[routing]\nmodels = ".ginga/models"\n' : o.toml;
  if (toml !== null) put(".ginga/project.toml", toml);
  sh(ws, "add", ".gitignore", ".ginga", "src");
  sh(ws, "commit", "-q", "-m", "init");
}

type Step = "ok" | "gate" | "timeout" | "quota_exhausted" | "infra";
type Req = { worktree: string; model?: string; provider?: string; prompt: string };

/** Uma etapa por chamada: `ok` escreve o arquivo, `gate` passa sem escrever (falha no done_when). */
function scripted(steps: Step[], file = "src/a1.ts") {
  const calls: Req[] = [];
  return {
    name: "pi",
    calls,
    family: () => "stub",
    async run(req: Req) {
      const step = steps[Math.min(calls.length, steps.length - 1)]!;
      calls.push(req);
      if (step === "ok") put(file, "export {};\n", req.worktree);
      const failed = step === "timeout" || step === "quota_exhausted" || step === "infra";
      return {
        passed: !failed,
        ...(failed ? { failure: step } : {}),
        stdout: "",
        stderr: "",
        costUsd: 0,
        model: req.model,
      };
    },
  };
}

async function runPlan(rt: unknown, opts: Record<string, unknown> = {}) {
  let mod: any = null;
  try {
    mod = await import(join(ROOT, "src/run.ts"));
  } catch {}
  expect(mod).not.toBeNull();
  return mod.runPlan({ root: ws, plan: "PLAN-0001", resolveRuntime: () => rt, ...opts });
}

const evs = (): Record<string, any>[] =>
  (existsSync(events) ? readFileSync(events, "utf8") : "")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const attempts = (task = "TASK-01") => evs().filter((e) => e.kind === "attempt" && e.task === task);
const models = (rt: { calls: Req[] }) => rt.calls.map((c) => c.model);

describe("escada de tiers", () => {
  test("duas falhas sobem de tier sem pedir OK: free×2 → medium×2 e depois blocked (sem strong automático)", async () => {
    setup();
    const rt = scripted(["timeout", "gate", "timeout", "gate", "timeout"]);
    const r = await runPlan(rt);
    expect(r.exitCode).toBe(1);
    expect(models(rt)).toEqual(["f1", "f2", "m1", "m2"]);
    expect(rt.calls.every((c) => c.provider === "opencode")).toBe(true);
    const a = attempts();
    expect(a.map((e) => e.data.attempt_n)).toEqual([1, 2, 3, 4]);
    expect(a.map((e) => e.data.tier)).toEqual(["free", "free", "medium", "medium"]);
    expect(a.map((e) => e.data.model)).toEqual(["f1", "f2", "m1", "m2"]);
    expect(a.map((e) => e.data.failure)).toEqual(["timeout", "done_when", "timeout", "done_when"]);
    expect(evs().some((e) => e.kind === "blocker" && e.data.raised_by === "manda")).toBe(true);
  });

  test("sucesso na 3ª tentativa (medium) para a escada e termina em done", async () => {
    setup();
    const rt = scripted(["timeout", "timeout", "ok"]);
    const r = await runPlan(rt);
    expect(r.exitCode).toBe(0);
    expect(models(rt)).toEqual(["f1", "f2", "m1"]);
    expect(attempts().map((e) => e.data.passed)).toEqual([false, false, true]);
    expect(existsSync(join(ws, "src/a1.ts"))).toBe(true);
    const trans = evs().filter((e) => e.kind === "transition" && e.task === "TASK-01");
    expect(trans[trans.length - 1]!.data.to).toBe("done");
    expect(evs().some((e) => e.kind === "blocker")).toBe(false);
  });

  test("a TASK começa no tier dela", async () => {
    setup({ tiers: ["medium"] });
    const rt = scripted(["ok"], "src/a1.ts");
    const r = await runPlan(rt);
    expect(r.exitCode).toBe(0);
    expect(models(rt)).toEqual(["m1"]);
    expect(attempts()[0]!.data.tier).toBe("medium");
  });

  test("candidato já tentado é pulado: tier com 1 candidato sobe sem repetir", async () => {
    setup({ free: ["opencode/f1"] });
    const rt = scripted(["timeout", "gate", "timeout", "gate"]);
    await runPlan(rt);
    expect(models(rt)).toEqual(["f1", "m1", "m2"]);
    expect(attempts().map((e) => e.data.tier)).toEqual(["free", "medium", "medium"]);
  });
});

describe("breaker", () => {
  for (const reason of ["gate", "timeout"] as const) {
    test(`3 falhas seguidas iguais (${reason === "gate" ? "done_when" : reason}) param antes do fim da escada`, async () => {
      setup();
      const rt = scripted([reason, reason, reason, reason, reason]);
      const r = await runPlan(rt);
      expect(r.exitCode).toBe(1);
      expect(models(rt)).toEqual(["f1", "f2", "m1"]);
      const blocker = evs().find((e) => e.kind === "blocker")!;
      expect(blocker.data.raised_by).toBe("manda");
      expect(blocker.task).toBe("TASK-01");
      expect(blocker.plan).toBe("PLAN-0001");
      expect(typeof blocker.data.blocker_id).toBe("string");
      expect(typeof blocker.data.question).toBe("string");
      expect(Array.isArray(blocker.data.options)).toBe(true);
    });
  }

  test("quota_exhausted e infra não contam: 5 falhas seguidas não disparam o breaker", async () => {
    setup();
    const rt = scripted(["quota_exhausted", "quota_exhausted", "infra", "quota_exhausted", "infra"]);
    await runPlan(rt);
    expect(models(rt)).toEqual(["f1", "f2", "m1", "m2"]);
  });

  test("falhas diferentes não somam: alternar done_when e timeout esgota a escada", async () => {
    setup();
    const rt = scripted(["gate", "timeout", "gate", "timeout", "gate"]);
    await runPlan(rt);
    expect(rt.calls.length).toBe(4);
  });
});

describe("blocked", () => {
  test("esgotou: transition para blocked (nunca failed), blocker no escopo da TASK e dependentes não rodam", async () => {
    setup({ tiers: ["free", "free"] });
    const rt = scripted(["timeout", "gate", "timeout", "gate", "timeout"]);
    const r = await runPlan(rt);
    expect(r.exitCode).toBe(1);
    const trans = evs().filter((e) => e.kind === "transition" && e.data.entity === "task" && e.task === "TASK-01");
    const last = trans[trans.length - 1]!;
    expect(last.data.to).toBe("blocked");
    expect(last.data.by).toBe("system");
    expect(trans.some((e) => e.data.to === "failed")).toBe(false);
    expect(evs().filter((e) => e.kind === "blocker").length).toBe(1);
    expect(evs().some((e) => e.task === "TASK-02")).toBe(false);
  });
});

describe("sem escada", () => {
  test("[runtimes] fixado no projeto ignora a escada: uma tentativa só", async () => {
    setup({ toml: '[routing]\nmodels = ".ginga/models"\n[runtimes]\nexecutor = "pi:opencode/pinado"\n' });
    const rt = scripted(["timeout", "timeout", "timeout"]);
    const r = await runPlan(rt);
    expect(r.exitCode).toBe(1);
    expect(rt.calls.length).toBe(1);
  });

  test("sem pasta de modelos: uma tentativa só, como no PLAN-0007", async () => {
    setup({ toml: null });
    const rt = scripted(["timeout", "timeout", "timeout"]);
    const r = await runPlan(rt);
    expect(r.exitCode).toBe(1);
    expect(rt.calls.length).toBe(1);
  });
});
