import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * PLAN-0013 TASK-07 (manda): `manda plan` cita no PLAN gerado as LESSONs
 * encontradas pelo touch das TASKs.
 *
 * - `lessonsForTouch(root, touch): { id, title, path }[]` em `src/plan_lessons.ts`:
 *   usa `ginga lessons find --touch <csv> --json` (cwd = root) quando `ginga`
 *   resolve no PATH; senão varre `.ginga/knowledge/lessons/LESSON-*.md` direto,
 *   com o mesmo match de `scope.files` (prefixo "dir/" ou glob com `*`/`?`).
 *   Mesmo resultado com e sem `ginga` no PATH.
 * - `planFromArtifact` (src/plan.ts): depois de validar os arquivos gerados,
 *   junta o `touch` de todas as TASKs, chama `lessonsForTouch` e anexa a seção
 *   `## Lessons` (id + path de cada lição, como link) ao PLAN.md gravado.
 *   Sem lição casando, nenhuma seção `## Lessons`.
 *
 * O import de `../src/plan_lessons` é dinâmico para o RED cair em asserção
 * (módulo ausente → expect(mod).not.toBeNull() falha), não em erro de import.
 */

import { planFromArtifact } from "../src/plan";

type PlanLessonsModule = typeof import("../src/plan_lessons");

async function loadPlanLessons(): Promise<PlanLessonsModule | null> {
  try {
    return await import("../src/plan_lessons");
  } catch {
    return null;
  }
}

const savedPath = process.env.PATH;
let ws: string;
let emptyPathDir: string;

function put(rel: string, text: string, root = ws) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

const LESSON_HIT = `---
id: LESSON-0001
title: "Nunca commitar na main"
scope:
  repo: manda
  files: ["src/*.ts"]
  symbols: []
  tags: [git]
---
evidence: incidente 22:48
`;

const LESSON_MISS = `---
id: LESSON-0002
title: "Licao de docs"
scope:
  repo: ginga
  files: ["docs/"]
---
evidence: outra
`;

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "manda-plan-lessons-")));
  emptyPathDir = realpathSync(mkdtempSync(join(tmpdir(), "manda-empty-path-")));
  put(".ginga/knowledge/lessons/LESSON-0001-nunca-main.md", LESSON_HIT);
  put(".ginga/knowledge/lessons/LESSON-0002-docs.md", LESSON_MISS);
});

afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(ws, { recursive: true, force: true });
  rmSync(emptyPathDir, { recursive: true, force: true });
});

describe("lessonsForTouch", () => {
  test("retorna a lição cujo scope.files casa com o touch (id, title, path relativa)", async () => {
    const mod = await loadPlanLessons();
    expect(mod).not.toBeNull();
    const got = mod!.lessonsForTouch(ws, ["src/plan.ts"]);
    expect(got).toHaveLength(1);
    expect(got[0]!.id).toBe("LESSON-0001");
    expect(got[0]!.title).toBe("Nunca commitar na main");
    expect(got[0]!.path).toBe("knowledge/lessons/LESSON-0001-nunca-main.md");
  });

  test("mesmo resultado com e sem `ginga` no PATH", async () => {
    const mod = await loadPlanLessons();
    expect(mod).not.toBeNull();
    const withGinga = mod!.lessonsForTouch(ws, ["src/plan.ts", "src/run.ts"]);
    process.env.PATH = emptyPathDir; // sem ginga: cai no fallback por arquivos
    const withoutGinga = mod!.lessonsForTouch(ws, ["src/plan.ts", "src/run.ts"]);
    process.env.PATH = savedPath;
    expect(withoutGinga).toEqual(withGinga);
    expect(withGinga.map((l) => l.id)).toEqual(["LESSON-0001"]);
  });

  test("sem lição casando retorna [] nos dois modos", async () => {
    const mod = await loadPlanLessons();
    expect(mod).not.toBeNull();
    const a = mod!.lessonsForTouch(ws, ["README.md"]);
    process.env.PATH = emptyPathDir;
    const b = mod!.lessonsForTouch(ws, ["README.md"]);
    process.env.PATH = savedPath;
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });

  test("diretório de lessons ausente retorna [] nos dois modos", async () => {
    const mod = await loadPlanLessons();
    expect(mod).not.toBeNull();
    rmSync(join(ws, ".ginga", "knowledge", "lessons"), { recursive: true, force: true });
    const a = mod!.lessonsForTouch(ws, ["src/plan.ts"]);
    process.env.PATH = emptyPathDir;
    const b = mod!.lessonsForTouch(ws, ["src/plan.ts"]);
    process.env.PATH = savedPath;
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });

  test('match por prefixo de diretório (scope.files com "src/")', async () => {
    const mod = await loadPlanLessons();
    expect(mod).not.toBeNull();
    put(".ginga/knowledge/lessons/LESSON-0003-prefixo.md", LESSON_HIT.replace('files: ["src/*.ts"]', 'files: ["src/"]').replace("LESSON-0001", "LESSON-0003").replace("Nunca commitar na main", "Prefixo dir"));
    const got = mod!.lessonsForTouch(ws, ["src/qualquer/coisa.ts"]);
    expect(got.map((l) => l.id).sort()).toEqual(["LESSON-0001", "LESSON-0003"]);
  });
});

// ---- integração: planFromArtifact anexa `## Lessons` ao PLAN.md gravado ----

const PLAN_MD = `---
type: plan
title: Aprofundar a skill
status: draft
---
## Objetivo
x
`;

function taskFile(planId: string, touch: string) {
  return [
    "---",
    "type: task",
    "mode: mvp",
    'goal: "goal TASK-01"',
    `plan: ${planId}`,
    "depends_on: []",
    "tier: free",
    `touch: [${touch}]`,
    'done_when: "true"',
    "tests_frozen: []",
    "---",
    "## Fazer",
    "- fazer",
  ].join("\n") + "\n";
}

function plannerReply(planId: string, touch: string) {
  return [
    `=== FILE: PLAN.md ===\n${PLAN_MD}`,
    `=== FILE: TASK-01-um.md ===\n${taskFile(planId, touch)}`,
  ].join("\n");
}

function setupPlanWs(withLessons: boolean) {
  if (withLessons) {
    put(".ginga/knowledge/lessons/LESSON-0001-nunca-main.md", LESSON_HIT);
  } else {
    rmSync(join(ws, ".ginga", "knowledge", "lessons"), { recursive: true, force: true });
  }
  put(".ginga/intents/INTENT-0004-deepen-skill.md", "---\ntype: intent\ntitle: deepen\n---\nQUERO a skill mais profunda\n");
  put(".ginga/plans/PLAN-0001-base/PLAN.md", "---\ntype: plan\ntitle: base\n---\n");
  put(".ginga/project.toml", '[runtimes]\nplanner = "pi:opencode/glm-5.3-flash-free"\n');
}

function fakePlanner(reply: (planId: string) => string) {
  return {
    name: "pi",
    run: async (req: { prompt: string }) => {
      const planId = req.prompt.match(/PLAN-\d{4}-[a-z0-9-]+/)![0]!;
      return { resultText: reply(planId) };
    },
  };
}

function writtenPlanMd(root: string): string {
  const plansDir = join(root, ".ginga", "plans");
  const dir = readdirSync(plansDir).find((d) => d.startsWith("PLAN-0002-"))!;
  return readFileSync(join(plansDir, dir, "PLAN.md"), "utf8");
}

describe("planFromArtifact inclui ## Lessons no PLAN gerado", () => {
  test("touch das TASKs casando com lesson → seção ## Lessons com id e path no PLAN.md gravado", async () => {
    setupPlanWs(true);
    const res = await planFromArtifact({
      root: ws,
      source: "INTENT-0004",
      resolveRuntime: () => fakePlanner((planId) => plannerReply(planId, "src/foo.ts")) as never,
    });
    expect(res.exitCode).toBe(0);
    const md = writtenPlanMd(ws);
    expect(md).toContain("## Lessons");
    expect(md).toContain("LESSON-0001");
    expect(md).toContain("knowledge/lessons/LESSON-0001-nunca-main.md");
  });

  test("sem lesson casando → PLAN.md gravado sem a seção ## Lessons", async () => {
    setupPlanWs(false);
    const res = await planFromArtifact({
      root: ws,
      source: "INTENT-0004",
      resolveRuntime: () => fakePlanner((planId) => plannerReply(planId, "src/foo.ts")) as never,
    });
    expect(res.exitCode).toBe(0);
    expect(writtenPlanMd(ws)).not.toContain("## Lessons");
  });

  test("a seção ## Lessons aparece também sem `ginga` no PATH (fallback)", async () => {
    setupPlanWs(true);
    process.env.PATH = emptyPathDir;
    const res = await planFromArtifact({
      root: ws,
      source: "INTENT-0004",
      resolveRuntime: () => fakePlanner((planId) => plannerReply(planId, "src/foo.ts")) as never,
    });
    process.env.PATH = savedPath;
    expect(res.exitCode).toBe(0);
    const md = writtenPlanMd(ws);
    expect(md).toContain("## Lessons");
    expect(md).toContain("LESSON-0001");
  });
});
