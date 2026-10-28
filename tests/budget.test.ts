import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Tetos de budget e OK do dono (PLAN-0008 TASK-05), exercitados por `runPlan`.
 *
 * - Teto vem do `budget:` do ROUTING.md (`[routing].models`): `task_usd`, `plan_usd`,
 *   `month_usd`, `warn_pct`; `ask_owner: [over_cap, runtime_claude]`.
 * - Gasto = soma de `cost_usd` das linhas `cost_source: "metered"` de
 *   `<root>/.ginga/state/manda-spend.jsonl` (`{ts, plan, task, cost_usd, cost_source}`),
 *   por TASK (plan+task), por PLAN, e por mês corrente. `subscription`/`unknown` não contam.
 *   Cada tentativa acrescenta uma linha.
 * - `spendCmd` (CLI `--spend-cmd`): comando que imprime `{"task":n,"plan":n,"month":n}` e
 *   substitui a leitura do jsonl (env MANDA_PLAN e MANDA_TASK). Chamado antes de cada tentativa.
 * - O teto é checado ANTES de cada tentativa: gasto >= teto → não chama o runtime, emite
 *   `blocker` (`raised_by: manda`, `scope` = task|plan|month|runtime_claude) e a TASK vai a `blocked`.
 * - Aviso: gasto >= warn_pct do teto e < teto → evento `budget` level `warn`; no teto → level `cap`.
 * - Próximo candidato com runtime `claude` pede OK (`runtime_claude`) antes de rodar.
 * - `approve: ["task"]` (CLI `--approve task`, env MANDA_APPROVED_SCOPES="task,plan") libera
 *   aquele escopo nesta execução.
 */

const ROOT = join(import.meta.dir, "..");
const saved = { events: process.env.GINGA_EVENTS, approved: process.env.MANDA_APPROVED_SCOPES };

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
  ws = realpathSync(mkdtempSync(join(tmpdir(), "manda-bud-")));
  events = join(ws, "..", `events-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.GINGA_EVENTS = events;
  delete process.env.MANDA_APPROVED_SCOPES;
  sh(ws, "init", "-q", "-b", "main");
  put(".gitignore", ".worktrees/\n.ginga/state/\n");
  put("src/base.ts", "export {};\n");
});
afterEach(() => {
  if (saved.events === undefined) delete process.env.GINGA_EVENTS;
  else process.env.GINGA_EVENTS = saved.events;
  if (saved.approved === undefined) delete process.env.MANDA_APPROVED_SCOPES;
  else process.env.MANDA_APPROVED_SCOPES = saved.approved;
  rmSync(ws, { recursive: true, force: true });
  rmSync(events, { force: true });
});

const PLAN = ".ginga/plans/PLAN-0001-x";
const SPEND = ".ginga/state/manda-spend.jsonl";

const ROUTING = (strong: string) => `---
type: policy
title: fixture
ladder:
  - {tier: free, tries: 2}
  - {tier: medium, tries: 2}
  - {tier: strong, tries: 1}
breaker: {same_reason: 3, ignore: [quota_exhausted, infra]}
pools:
  executor:
    free: [opencode/f1, opencode/f2]
    medium: [opencode/m1, opencode/m2]
    strong: [${strong}]
budget: {month_usd: 10, task_usd: 0.25, plan_usd: 1.5, warn_pct: 80}
ask_owner: [over_cap, runtime_claude]
---
fixture
`;

function setup(o: { tier?: string; strong?: string } = {}) {
  put(`${PLAN}/PLAN.md`, '---\ntype: plan\ntitle: t\nstatus: approved\ndone_when: "true"\n---\n');
  put(
    `${PLAN}/TASK-01-t.md`,
    [
      "---",
      "type: task",
      "mode: mvp",
      'goal: "goal"',
      "plan: PLAN-0001-x",
      "depends_on: []",
      `tier: ${o.tier ?? "free"}`,
      "touch: [src/a1.ts]",
      'done_when: "test -f src/a1.ts"',
      "---",
      "corpo",
    ].join("\n") + "\n",
  );
  put(".ginga/models/ROUTING.md", ROUTING(o.strong ?? "opencode/s1"));
  put(".ginga/project.toml", '[routing]\nmodels = ".ginga/models"\n');
  sh(ws, "add", ".gitignore", ".ginga", "src");
  sh(ws, "commit", "-q", "-m", "init");
}

type Req = { worktree: string; model?: string; provider?: string };
type Step = { r: "ok" | "timeout" | "gate"; cost?: number };

/** `r: ok` escreve o arquivo; `gate` passa sem escrever; `cost` ausente = custo desconhecido. Cicla as etapas. */
function scripted(steps: Step[], name = "pi") {
  const calls: Req[] = [];
  return {
    name,
    calls,
    family: () => "stub",
    async run(req: Req) {
      const step = steps[calls.length % steps.length]!;
      calls.push(req);
      if (step.r === "ok") put("src/a1.ts", "export {};\n", req.worktree);
      return {
        passed: step.r !== "timeout",
        ...(step.r === "timeout" ? { failure: "timeout" } : {}),
        stdout: "",
        stderr: "",
        ...(step.cost === undefined ? {} : { costUsd: step.cost }),
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
  const resolved: string[] = [];
  const r = await mod.runPlan({
    root: ws,
    plan: "PLAN-0001",
    resolveRuntime: (n: string) => {
      resolved.push(n);
      return rt;
    },
    ...opts,
  });
  return { ...r, resolved };
}

const evs = (): Record<string, any>[] =>
  (existsSync(events) ? readFileSync(events, "utf8") : "")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const spendLines = (): Record<string, any>[] =>
  (existsSync(join(ws, SPEND)) ? readFileSync(join(ws, SPEND), "utf8") : "")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
function seed(...lines: Array<{ plan: string; task: string; cost_usd: number; cost_source?: string; ts?: string }>) {
  put(
    SPEND,
    lines.map((l) => JSON.stringify({ ts: new Date().toISOString(), cost_source: "metered", ...l })).join("\n") + "\n",
  );
}
const blockers = () => evs().filter((e) => e.kind === "blocker");
const lastTransition = () => {
  const t = evs().filter((e) => e.kind === "transition" && e.task === "TASK-01");
  return t[t.length - 1]!;
};

describe("registro do gasto", () => {
  test("cada tentativa acrescenta uma linha em manda-spend.jsonl; só metered tem custo contado", async () => {
    setup();
    const rt = scripted([{ r: "timeout", cost: 0.01 }, { r: "ok" }]);
    const r = await runPlan(rt);
    expect(r.exitCode).toBe(0);
    const lines = spendLines();
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatchObject({ plan: "PLAN-0001", task: "TASK-01", cost_usd: 0.01, cost_source: "metered" });
    expect(typeof lines[0]!.ts).toBe("string");
    expect(lines[1]!.cost_source).toBe("unknown");
  });
});

describe("tetos", () => {
  test("TASK: aviso em 80% e para no teto antes da próxima tentativa", async () => {
    setup();
    const rt = scripted([{ r: "timeout", cost: 0.21 }, { r: "gate", cost: 0.21 }]);
    const r = await runPlan(rt);
    expect(r.exitCode).toBe(1);
    expect(rt.calls.length).toBe(2); // 0,21 (aviso) → 0,42 >= 0,25 (teto): sem 3ª tentativa
    const budget = evs().filter((e) => e.kind === "budget");
    expect(budget.find((e) => e.data.level === "warn")?.data).toMatchObject({ scope: "task", cap_usd: 0.25 });
    expect(budget.find((e) => e.data.level === "cap")?.data).toMatchObject({ scope: "task", cap_usd: 0.25 });
    expect(budget.find((e) => e.data.level === "cap")!.data.spent_usd).toBeGreaterThanOrEqual(0.25);
    expect(blockers().length).toBe(1);
    expect(blockers()[0]!.data).toMatchObject({ raised_by: "manda", scope: "task" });
    expect(typeof blockers()[0]!.data.question).toBe("string");
    expect(lastTransition().data.to).toBe("blocked");
  });

  test("PLAN: gasto de outras TASKs do mesmo PLAN no teto → nenhuma chamada", async () => {
    setup();
    seed({ plan: "PLAN-0001", task: "TASK-09", cost_usd: 1.5 });
    const rt = scripted([{ r: "ok", cost: 0 }]);
    const r = await runPlan(rt);
    expect(r.exitCode).toBe(1);
    expect(rt.calls.length).toBe(0);
    expect(blockers()[0]!.data.scope).toBe("plan");
    expect(lastTransition().data.to).toBe("blocked");
  });

  test("PLAN: gasto de outro PLAN não conta", async () => {
    setup();
    seed({ plan: "PLAN-0099", task: "TASK-01", cost_usd: 5 });
    const ok = await runPlan(scripted([{ r: "ok", cost: 0 }]));
    expect(ok.exitCode).toBe(0);
  });

  test("mês: gasto deste mês no teto bloqueia", async () => {
    setup();
    seed({ plan: "PLAN-0000", task: "TASK-01", cost_usd: 10 });
    const rt = scripted([{ r: "ok", cost: 0 }]);
    const r = await runPlan(rt);
    expect(r.exitCode).toBe(1);
    expect(rt.calls.length).toBe(0);
    expect(blockers()[0]!.data.scope).toBe("month");
  });

  test("mês: gasto de meses anteriores não conta", async () => {
    setup();
    seed({ plan: "PLAN-0000", task: "TASK-01", cost_usd: 10, ts: "2020-01-15T00:00:00.000Z" });
    const ok = await runPlan(scripted([{ r: "ok", cost: 0 }]));
    expect(ok.exitCode).toBe(0);
  });

  test("assinatura e custo desconhecido não são descontados como custo", async () => {
    setup();
    seed(
      { plan: "PLAN-0001", task: "TASK-09", cost_usd: 5, cost_source: "subscription" },
      { plan: "PLAN-0001", task: "TASK-09", cost_usd: 5, cost_source: "unknown" },
    );
    const rt = scripted([{ r: "ok", cost: 0 }]);
    const r = await runPlan(rt);
    expect(r.exitCode).toBe(0);
    expect(rt.calls.length).toBe(1);
  });
});

describe("--spend-cmd (fonte do ginga)", () => {
  test("o comando manda no gasto e o jsonl é ignorado", async () => {
    setup();
    seed({ plan: "PLAN-0001", task: "TASK-09", cost_usd: 1.5 }); // estouraria o PLAN se fosse lido
    const ok = scripted([{ r: "ok", cost: 0 }]);
    const a = await runPlan(ok, { spendCmd: `echo '{"task":0,"plan":0,"month":0}'` });
    expect(a.exitCode).toBe(0);
    expect(ok.calls.length).toBe(1);
  });

  test("o comando no teto bloqueia mesmo com o jsonl vazio", async () => {
    setup();
    const no = scripted([{ r: "ok", cost: 0 }]);
    const b = await runPlan(no, { spendCmd: `echo '{"task":0,"plan":1.5,"month":0}'` });
    expect(b.exitCode).toBe(1);
    expect(no.calls.length).toBe(0);
    expect(blockers()[0]!.data.scope).toBe("plan");
  });

  test("recebe MANDA_PLAN e MANDA_TASK no ambiente", async () => {
    setup();
    const cmd =
      `if [ "$MANDA_PLAN" = PLAN-0001 ] && [ "$MANDA_TASK" = TASK-01 ]; then ` +
      `echo '{"task":0,"plan":1.5,"month":0}'; else echo '{"task":0,"plan":0,"month":0}'; fi`;
    const rt = scripted([{ r: "ok", cost: 0 }]);
    const r = await runPlan(rt, { spendCmd: cmd });
    expect(r.exitCode).toBe(1);
    expect(rt.calls.length).toBe(0);
    expect(blockers()[0]!.data.scope).toBe("plan");
  });
});

describe("OK do dono", () => {
  test("approve libera o escopo aprovado nesta execução", async () => {
    setup();
    const free = scripted([{ r: "timeout", cost: 0.21 }, { r: "gate", cost: 0.21 }]);
    const r = await runPlan(free, { approve: ["task"] });
    expect(r.exitCode).toBe(1);
    expect(free.calls.length).toBe(5); // escada inteira, sem parar no teto da TASK
    expect(blockers().filter((b) => b.data.scope === "task").length).toBe(0);
  });

  test("approve de outro escopo não libera o teto da TASK", async () => {
    setup();
    const wrong = scripted([{ r: "timeout", cost: 0.21 }, { r: "gate", cost: 0.21 }]);
    await runPlan(wrong, { approve: ["plan"] });
    expect(wrong.calls.length).toBe(2);
    expect(blockers()[0]!.data.scope).toBe("task");
  });

  test("MANDA_APPROVED_SCOPES (lista separada por vírgula) equivale a --approve", async () => {
    setup();
    process.env.MANDA_APPROVED_SCOPES = "plan,task";
    const rt = scripted([{ r: "timeout", cost: 0.21 }, { r: "gate", cost: 0.21 }]);
    await runPlan(rt);
    expect(rt.calls.length).toBe(5);
  });

  test("próximo candidato claude pede OK e não roda", async () => {
    setup({ tier: "strong", strong: "claude/claude-sonnet-5-5" });
    const no = scripted([{ r: "ok", cost: 0 }], "claude");
    const r = await runPlan(no);
    expect(r.exitCode).toBe(1);
    expect(no.calls.length).toBe(0);
    expect(r.resolved).not.toContain("claude");
    expect(blockers()[0]!.data).toMatchObject({ raised_by: "manda", scope: "runtime_claude" });
    expect(lastTransition().data.to).toBe("blocked");
  });

  test("com runtime_claude aprovado, o candidato claude roda", async () => {
    setup({ tier: "strong", strong: "claude/claude-sonnet-5-5" });
    const yes = scripted([{ r: "ok", cost: 0 }], "claude");
    const ok = await runPlan(yes, { approve: ["runtime_claude"] });
    expect(ok.exitCode).toBe(0);
    expect(ok.resolved).toContain("claude");
    expect(yes.calls[0]!.model).toBe("claude-sonnet-5-5");
  });

  test("a escada que cai no claude para ali: free×2, medium×2 e pede OK antes da 5ª", async () => {
    setup({ strong: "claude/claude-sonnet-5-5" });
    const rt = scripted([{ r: "timeout", cost: 0 }, { r: "gate", cost: 0 }, { r: "timeout", cost: 0 }, { r: "gate", cost: 0 }]);
    const r = await runPlan(rt);
    expect(r.exitCode).toBe(1);
    expect(rt.calls.length).toBe(4);
    expect(blockers()[0]!.data.scope).toBe("runtime_claude");
  });
});

describe("manda run (CLI)", () => {
  test("--approve e --spend-cmd são aceitos (PLAN inexistente sai com 2 sem erro de uso)", () => {
    const r = Bun.spawnSync(
      ["bun", join(ROOT, "bin/manda.ts"), "run", "PLAN-9999", "--approve", "task", "--spend-cmd", "echo {}", "--root", ws],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("plan não encontrado");
  });
});
