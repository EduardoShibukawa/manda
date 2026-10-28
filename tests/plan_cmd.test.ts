import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * `manda plan <INTENT|SPEC>` (PLAN-0008 TASK-08): `planFromArtifact` de `src/plan.ts`, com runtime injetado.
 *
 * - `planFromArtifact({ root, source, resolveRuntime? })`; `source` é o id (`INTENT-0004`, prefixo do arquivo em
 *   `.ginga/intents/` ou `.ginga/specs/`) ou um caminho. Fonte inexistente → exit 2, sem rodar o Planner.
 *   CLI: `manda plan <INTENT|SPEC> [--root D]`; `manda plan show` segue como está.
 * - Papel `planner`: `[runtimes].planner` (`runtime:provider/modelo`), `role: "planner"`; sem rota → exit ≠ 0
 *   citando `[runtimes]` e sem rodar nada.
 * - O diretório novo é `.ginga/plans/PLAN-<N+1>-<slug>` (N = maior PLAN existente, 4 dígitos; slug = nome do
 *   INTENT/SPEC sem o id); o prompt cita esse id, o texto da fonte e os campos do formato do doc 04.
 * - A resposta do Planner traz um arquivo por bloco que começa em `=== FILE: <nome> ===` (`PLAN.md`, `TASK-*.md`).
 * - Validação própria: PLAN.md com `type`, `title`; cada TASK com `type`, `mode`, `goal`, `plan` (= nome da pasta),
 *   `depends_on` (só TASKs existentes, sem ciclo), `tier`, `touch`, `done_when`, `tests_frozen` (a chave existe) e no
 *   máx. 25 linhas. Com `ginga` no PATH, roda `ginga lint <pasta>` numa cópia de staging: exit ≠ 0 também é inválido.
 * - Inválido → 1 retry com os erros no prompt; depois exit 1 sem gravar nada. `status: draft` sempre (a resposta
 *   pode pedir `approved`; o manda grava `draft`).
 */

const ROOT = join(import.meta.dir, "..");
const savedPath = process.env.PATH;

let ws: string;
const PLANS = ".ginga/plans";

function put(rel: string, text: string, root = ws) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "manda-plan-")));
  put(".ginga/intents/INTENT-0004-deepen-skill.md", "---\ntype: intent\ntitle: deepen\n---\nQUERO a skill mais profunda (marcador-do-intent)\n");
  put(".ginga/specs/SPEC-0002-algo.md", "---\ntype: spec\ntitle: algo\n---\ncorpo da spec (marcador-da-spec)\n");
  put(".ginga/plans/PLAN-0003-a/PLAN.md", "---\ntype: plan\ntitle: a\n---\n");
  put(".ginga/project.toml", '[runtimes]\nplanner = "pi:opencode/glm-5.3-flash-free"\n');
});
afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(ws, { recursive: true, force: true });
});

const PLAN_MD = (status = "draft") => `---\ntype: plan\ntitle: Aprofundar a skill\nstatus: ${status}\ndone_when: "true"\n---\n## Objetivo\nx\n`;
const task = (id: string, id_plan: string, o: { deps?: string; drop?: string; extra?: string } = {}) =>
  [
    "---",
    "type: task",
    "mode: mvp",
    `goal: "goal ${id}"`,
    `plan: ${id_plan}`,
    `depends_on: [${o.deps ?? ""}]`,
    "tier: free",
    `touch: [src/${id}.ts]`,
    ...(o.drop === "done_when" ? [] : [`done_when: "test -f src/${id}.ts"`]),
    "tests_frozen: []",
    "---",
    "## Fazer",
    o.extra ?? "- fazer",
  ].join("\n") + "\n";

function files(planId: string, parts: Record<string, string>) {
  return Object.entries(parts)
    .map(([name, body]) => `=== FILE: ${name} ===\n${body}`)
    .join("\n");
}
const ids = (prompt: string) => prompt.match(/PLAN-0004-[a-z0-9-]+/)![0];

type Req = { worktree: string; model?: string; provider?: string; prompt: string; role?: string };

/** Uma resposta por chamada (a última se repete); recebe o id do PLAN lido do prompt. */
function planner(replies: ((planId: string) => string)[]) {
  const calls: Req[] = [];
  return {
    name: "pi",
    calls,
    family: () => "stub",
    async run(req: Req) {
      const reply = replies[Math.min(calls.length, replies.length - 1)]!;
      calls.push(req);
      return { passed: true, stdout: "", stderr: "", resultText: reply(ids(req.prompt)), costUsd: 0, model: req.model };
    },
  };
}
const good = (planId: string) =>
  files(planId, {
    "PLAN.md": PLAN_MD("approved"),
    "TASK-01-a.md": task("a", planId),
    "TASK-02-b.md": task("b", planId, { deps: "TASK-01-a" }),
  });

async function plan(rt: unknown, source = "INTENT-0004") {
  let mod: any = null;
  try {
    mod = await import(join(ROOT, "src/plan.ts"));
  } catch {}
  expect(mod).not.toBeNull();
  return mod.planFromArtifact({ root: ws, source, resolveRuntime: () => rt });
}
const dirs = () => readdirSync(join(ws, PLANS)).sort();

describe("manda plan: gravação", () => {
  test("INTENT vira PLAN-0004-deepen-skill com PLAN.md e TASK-*.md, sempre draft", async () => {
    const rt = planner([good]);
    const r = await plan(rt);
    expect(r.exitCode).toBe(0);
    expect(dirs()).toEqual(["PLAN-0003-a", "PLAN-0004-deepen-skill"]);
    const d = join(ws, PLANS, "PLAN-0004-deepen-skill");
    expect(readdirSync(d).sort()).toEqual(["PLAN.md", "TASK-01-a.md", "TASK-02-b.md"]);
    const text = readFileSync(join(d, "PLAN.md"), "utf8");
    expect(text).toMatch(/^status: draft$/m);
    expect(text).not.toContain("approved");
  });

  test("SPEC também é fonte; o prompt traz o texto da fonte, o id do PLAN e os campos do formato", async () => {
    const rt = planner([(id) => good(id)]);
    const r = await plan(rt, "SPEC-0002");
    expect(r.exitCode).toBe(0);
    expect(dirs()).toContain("PLAN-0004-algo");
    const p = rt.calls[0]!.prompt;
    expect(p).toContain("marcador-da-spec");
    for (const campo of ["touch", "done_when", "tests_frozen", "depends_on"]) expect(p).toContain(campo);
  });

  test("usa o papel planner de [runtimes] (provider/modelo explícitos)", async () => {
    const rt = planner([good]);
    await plan(rt);
    expect(rt.calls[0]).toMatchObject({ provider: "opencode", model: "glm-5.3-flash-free", role: "planner" });
    expect(rt.calls[0]!.prompt).toContain("marcador-do-intent");
  });
});

describe("manda plan: falhas fechadas", () => {
  test("fonte inexistente: exit 2 e o Planner não roda", async () => {
    const rt = planner([good]);
    const r = await plan(rt, "INTENT-9999");
    expect(r.exitCode).toBe(2);
    expect(rt.calls.length).toBe(0);
  });

  test("sem [runtimes].planner nem pool: exit ≠ 0, cita [runtimes] e não roda", async () => {
    put(".ginga/project.toml", "");
    const rt = planner([good]);
    const logs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    let r: any;
    try {
      r = await plan(rt);
    } finally {
      console.error = orig;
    }
    expect(r.exitCode).not.toBe(0);
    expect(rt.calls.length).toBe(0);
    expect(logs.join("\n")).toContain("[runtimes]");
  });
});

describe("manda plan: validação e retry", () => {
  test("TASK sem done_when: 1 retry com o erro no prompt; a 2ª resposta válida é gravada", async () => {
    const bad = (id: string) => files(id, { "PLAN.md": PLAN_MD(), "TASK-01-a.md": task("a", id, { drop: "done_when" }) });
    const rt = planner([bad, good]);
    const r = await plan(rt);
    expect(r.exitCode).toBe(0);
    expect(rt.calls.length).toBe(2);
    expect(rt.calls[1]!.prompt).toContain("done_when");
    expect(rt.calls[1]!.prompt).toContain("TASK-01-a.md");
    expect(dirs()).toContain("PLAN-0004-deepen-skill");
  });

  test("duas respostas inválidas: exit 1 e nada é gravado", async () => {
    const bad = (id: string) => files(id, { "PLAN.md": PLAN_MD(), "TASK-01-a.md": task("a", id, { drop: "done_when" }) });
    const rt = planner([bad]);
    const r = await plan(rt);
    expect(r.exitCode).toBe(1);
    expect(rt.calls.length).toBe(2);
    expect(dirs()).toEqual(["PLAN-0003-a"]);
  });

  test("ciclo em depends_on e plan: diferente da pasta são inválidos", async () => {
    const cyc = (id: string) =>
      files(id, {
        "PLAN.md": PLAN_MD(),
        "TASK-01-a.md": task("a", id, { deps: "TASK-02-b" }),
        "TASK-02-b.md": task("b", id, { deps: "TASK-01-a" }),
      });
    const rt = planner([cyc, (id) => files(id, { "PLAN.md": PLAN_MD(), "TASK-01-a.md": task("a", "PLAN-0001-outro") })]);
    const r = await plan(rt);
    expect(r.exitCode).toBe(1);
    expect(rt.calls[1]!.prompt).toMatch(/ciclo/);
    expect(dirs()).toEqual(["PLAN-0003-a"]);
  });

  test("TASK com mais de 25 linhas é inválida", async () => {
    const longo = (id: string) => files(id, { "PLAN.md": PLAN_MD(), "TASK-01-a.md": task("a", id, { extra: Array(30).fill("- linha").join("\n") }) });
    const rt = planner([longo]);
    const r = await plan(rt);
    expect(r.exitCode).toBe(1);
    expect(rt.calls[1]!.prompt).toContain("25");
    expect(dirs()).toEqual(["PLAN-0003-a"]);
  });
});

describe("manda plan: ginga lint opcional", () => {
  function fakeGinga(exit: number, out: string) {
    const bin = join(ws, "bin");
    put("bin/ginga", `#!/bin/sh\necho "$1" > ${ws}/ginga.cmd\nls "$2" > ${ws}/ginga.files\necho "${out}"\nexit ${exit}\n`);
    chmodSync(join(bin, "ginga"), 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
  }

  test("com ginga no PATH roda `ginga lint <pasta com os arquivos>` antes de gravar", async () => {
    fakeGinga(0, "ok");
    const r = await plan(planner([good]));
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(ws, "ginga.cmd"), "utf8").trim()).toBe("lint");
    expect(readFileSync(join(ws, "ginga.files"), "utf8").split("\n").filter(Boolean)).toEqual(["PLAN.md", "TASK-01-a.md", "TASK-02-b.md"]);
  });

  test("lint com exit ≠ 0 conta como inválido: o retry recebe a saída do lint", async () => {
    fakeGinga(1, "ERRO-DO-LINT");
    const rt = planner([good]);
    const r = await plan(rt);
    expect(r.exitCode).toBe(1);
    expect(rt.calls.length).toBe(2);
    expect(rt.calls[1]!.prompt).toContain("ERRO-DO-LINT");
    expect(dirs()).toEqual(["PLAN-0003-a"]);
  });
});

describe("manda plan (CLI)", () => {
  function cli(args: string[]) {
    const r = Bun.spawnSync(["bun", join(ROOT, "bin", "manda.ts"), "plan", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, err: r.stderr.toString() };
  }
  test("fonte inexistente: exit 2 citando o id", () => {
    const r = cli(["INTENT-9999", "--root", ws]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("INTENT-9999");
  });
  test("o uso cita as duas formas", () => {
    const r = cli([]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("manda plan <INTENT|SPEC>");
    expect(r.err).toContain("manda plan show");
  });
  test("plan show continua funcionando", () => {
    put(`${PLANS}/PLAN-0003-a/TASK-01-a.md`, "---\ntype: task\ntier: free\n---\n");
    const r = Bun.spawnSync(["bun", join(ROOT, "bin", "manda.ts"), "plan", "show", "PLAN-0003", "--json", "--root", ws], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString()).tasks[0].task).toBe("TASK-01-a");
  });
});
