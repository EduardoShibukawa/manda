import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * T114: `manda plan` com o `ginga lint` real.
 *
 * O staging do `manda plan` é uma pasta plana (PLAN.md + TASK-*.md), mas o `ginga lint` real valida um bundle
 * `.ginga` (`plans/<PLAN>/…`): numa pasta plana ele sempre acusa erros relacionais ("PLAN sem nenhuma TASK",
 * "plan inexistente", "depends_on inexistente"…), que só fazem sentido depois de gravar. Contrato:
 * - com `ginga lint --json` em exit ≠ 0, só erros de frontmatter bloqueiam (mensagem `obrigatório`, `inválido: …`
 *   ou campo `frontmatter`); erros relacionais do staging plano são ignorados;
 * - o prompt do Planner pede `intent` no PLAN.md (campo obrigatório do lint real);
 * - a suíte é hermética: `tests/setup.ts` (preload do bunfig.toml) tira do PATH os diretórios com um `ginga`
 *   real, então `bun test tests/plan_cmd.test.ts` passa mesmo com um `ginga` reprovador no PATH.
 */

const ROOT = join(import.meta.dir, "..");
const savedPath = process.env.PATH;
let ws: string;

function put(rel: string, text: string) {
  const p = join(ws, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "manda-lintreal-")));
  put(".ginga/intents/INTENT-0004-deepen-skill.md", "---\ntype: intent\ntitle: deepen\n---\nQUERO a skill mais profunda\n");
  put(".ginga/plans/PLAN-0003-a/PLAN.md", "---\ntype: plan\ntitle: a\n---\n");
  put(".ginga/project.toml", '[runtimes]\nplanner = "pi:opencode/glm-5.3-flash-free"\n');
  process.env.PATH = savedPath;
});
afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(ws, { recursive: true, force: true });
});

const PLAN_MD = `---\ntype: plan\ntitle: Aprofundar a skill\nintent: INTENT-0004-deepen-skill\nstatus: draft\ndone_when: "true"\n---\n## Objetivo\nx\n`;
const task = (id: string, plan: string) =>
  `---\ntype: task\nmode: mvp\ngoal: "goal ${id}"\nplan: ${plan}\ndepends_on: []\ntier: free\ntouch: [src/${id}.ts]\ndone_when: "test -f src/${id}.ts"\ntests_frozen: []\n---\n## Fazer\n- fazer\n`;
const good = (planId: string) =>
  `=== FILE: PLAN.md ===\n${PLAN_MD}\n=== FILE: TASK-01-a.md ===\n${task("a", planId)}`;

function planner(reply: (id: string) => string) {
  const calls: { prompt: string }[] = [];
  return {
    name: "pi",
    calls,
    family: () => "stub",
    async run(req: { prompt: string; model?: string }) {
      calls.push(req);
      return { passed: true, stdout: "", stderr: "", resultText: reply(req.prompt.match(/PLAN-0004-[a-z0-9-]+/)![0]), costUsd: 0, model: req.model };
    },
  };
}

async function plan(rt: unknown) {
  const mod: any = await import(join(ROOT, "src/plan.ts"));
  return mod.planFromArtifact({ root: ws, source: "INTENT-0004", resolveRuntime: () => rt });
}

function stubGinga(dir: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ginga"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, "ginga"), 0o755);
}

const FLAT_ERRORS = JSON.stringify({
  ok: false,
  errors: [
    { file: "PLAN.md", field: "tasks", message: "PLAN sem nenhuma TASK" },
    { file: "TASK-01-a.md", field: "plan", message: "plan inexistente: PLAN-0004-deepen-skill" },
    { file: "TASK-01-a.md", field: "depends_on", message: "depends_on inexistente: TASK-00-x" },
    { file: "PLAN.md", field: "id", message: "numeração não sequencial: faltam 0001, 0002" },
  ],
});

describe("manda plan com o ginga lint real (staging plano)", () => {
  test("só erros relacionais do staging plano: o PLAN é gravado", async () => {
    stubGinga(join(ws, "bin"), `echo '${FLAT_ERRORS}'\nexit 1`);
    process.env.PATH = `${join(ws, "bin")}:${savedPath}`;
    const r = await plan(planner(good));
    expect(r.exitCode).toBe(0);
    expect(readdirSync(join(ws, ".ginga/plans")).sort()).toEqual(["PLAN-0003-a", "PLAN-0004-deepen-skill"]);
  });

  test("erro de frontmatter (`obrigatório`) continua bloqueando; o retry recebe a mensagem", async () => {
    const errs = JSON.stringify({ ok: false, errors: [{ file: "PLAN.md", field: "intent", message: "obrigatório" }] });
    stubGinga(join(ws, "bin"), `echo '${errs}'\nexit 1`);
    process.env.PATH = `${join(ws, "bin")}:${savedPath}`;
    const rt = planner(good);
    const r = await plan(rt);
    expect(r.exitCode).toBe(1);
    expect(rt.calls.length).toBe(2);
    expect(rt.calls[1]!.prompt).toContain("intent");
    expect(readdirSync(join(ws, ".ginga/plans"))).toEqual(["PLAN-0003-a"]);
  });

  test("saída que não é JSON em exit ≠ 0 continua inválida (fail closed)", async () => {
    stubGinga(join(ws, "bin"), `echo 'quebrou'\nexit 1`);
    process.env.PATH = `${join(ws, "bin")}:${savedPath}`;
    const r = await plan(planner(good));
    expect(r.exitCode).toBe(1);
  });

  test("o prompt do Planner pede `intent` entre os campos obrigatórios do PLAN.md", async () => {
    const rt = planner(good);
    await plan(rt);
    expect(rt.calls[0]!.prompt).toMatch(/Campos obrigatórios:[^\n]*\bintent\b/);
  });
});

describe("suíte hermética quanto ao ginga do PATH", () => {
  test("bun test tests/plan_cmd.test.ts passa com um `ginga` reprovador no PATH", () => {
    const bin = join(ws, "evil-bin");
    stubGinga(bin, `echo 'PLAN.md: tasks: PLAN sem nenhuma TASK'\nexit 1`);
    const r = Bun.spawnSync(["bun", "test", "tests/plan_cmd.test.ts"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${bin}:${savedPath}` },
    });
    const out = r.stdout.toString() + r.stderr.toString();
    expect(out).toMatch(/\b0 fail\b/);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(ROOT, "tests/setup.ts"))).toBe(true);
  });
});
