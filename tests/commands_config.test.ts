import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * T903: o manda não chama `ginga` por nome fixo. `lint`, `lessons` e `cost`
 * vêm de `[commands]` do `.ginga/project.toml`; o `ginga …` é só o padrão e
 * `"none"` desliga a chamada (valem os fallbacks que já existiam).
 */
const ROOT = join(import.meta.dir, "..");
const load = async (rel: string): Promise<any> => import(join(ROOT, rel));

let root: string;
let bin: string;
let savedPath: string;
const scratch: string[] = [];

function put(rel: string, text: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

function commands(lines: string[]) {
  put(".ginga/project.toml", ["[budget]", "round_usd = 1.00", "", "[commands]", ...lines, ""].join("\n"));
}

function gingaCalls(): string {
  return existsSync(join(bin, "ginga.log")) ? readFileSync(join(bin, "ginga.log"), "utf8") : "";
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "manda-cmds-")));
  bin = realpathSync(mkdtempSync(join(tmpdir(), "manda-cmds-BIN-")));
  scratch.push(root, bin);
  // `ginga` espião: registra a chamada e devolve JSON vazio com exit 0
  writeFileSync(join(bin, "ginga"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${bin}/ginga.log"\necho '{}'\nexit 0\n`);
  chmodSync(join(bin, "ginga"), 0o755);
  savedPath = process.env.PATH ?? "";
  process.env.PATH = `${bin}:${savedPath}`;
});

afterEach(() => {
  process.env.PATH = savedPath;
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  scratch.length = 0;
});

describe("projectCommand", () => {
  test("sem config devolve o padrão; com config, o valor; none vira null", async () => {
    const { projectCommand } = await load("src/project.ts");
    expect(projectCommand(root, "lint", "ginga lint {dir} --json")).toBe("ginga lint {dir} --json");
    commands(['lint = "meu-lint {dir}"', 'cost = "none"']);
    expect(projectCommand(root, "lint", "ginga lint {dir} --json")).toBe("meu-lint {dir}");
    expect(projectCommand(root, "cost", "ginga cost --json")).toBeNull();
  });

  test("runProjectCommand põe as variáveis entre aspas e devolve exit e stdout", async () => {
    const { runProjectCommand } = await load("src/project.ts");
    const r = runProjectCommand("printf '%s|' {a} {b}", { a: "com espaço", b: "x'y" }, root);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("com espaço|x'y|");
  });
});

describe("lessons por [commands].lessons", () => {
  test("usa o comando configurado e não chama o ginga", async () => {
    const out = join(bin, "touch.txt");
    commands([`lessons = "printf %s {touch} > ${out}; echo '{\\"lessons\\":[{\\"id\\":\\"L-9\\",\\"title\\":\\"t\\",\\"path\\":\\"p\\"}]}'"`]);
    const { lessonsForTouch } = await load("src/plan_lessons.ts");
    expect(lessonsForTouch(root, ["src/a.ts", "src/b.ts"])).toEqual([{ id: "L-9", title: "t", path: "p" }]);
    expect(readFileSync(out, "utf8")).toBe("src/a.ts,src/b.ts");
    expect(gingaCalls()).toBe("");
  });

  test('"none" cai direto na varredura dos arquivos, sem chamar o ginga', async () => {
    commands(['lessons = "none"']);
    put(".ginga/knowledge/lessons/LESSON-0001-x.md", "---\ntype: lesson\nid: LESSON-0001\ntitle: X\nscope:\n  files:\n    - src/\n---\n");
    const { lessonsForTouch } = await load("src/plan_lessons.ts");
    expect(lessonsForTouch(root, ["src/a.ts"]).map((l: { id: string }) => l.id)).toEqual(["LESSON-0001"]);
    expect(gingaCalls()).toBe("");
  });
});

describe("cost por [commands].cost", () => {
  const call = async () =>
    (await load("src/cost_cap.ts")).checkPaidCall({
      root,
      since: "2026-01-01T00:00:00.000Z",
      next_estimate_usd: 0.3,
      model: "opencode/deepseek-v4-pro",
      opencodeDb: join(root, "nao-existe.db"),
    });

  test("usa o comando configurado: gasto acima do teto nega", async () => {
    commands([`cost = "echo '{\\"spent_usd\\": 0.9}'"`]);
    expect((await call()).allow).toBe(false);
    expect(gingaCalls()).toBe("");
  });

  test("gasto abaixo do teto libera", async () => {
    commands([`cost = "echo '{\\"spent_usd\\": 0.1}'"`]);
    expect((await call()).allow).toBe(true);
  });

  test('"none" usa a soma local, sem chamar o ginga', async () => {
    commands(['cost = "none"']);
    expect((await call()).allow).toBe(true);
    expect(gingaCalls()).toBe("");
  });
});

describe("lint por [commands].lint", () => {
  test("comando configurado que acusa erro bloqueante reprova", async () => {
    commands([`lint = "echo '{\\"errors\\":[{\\"file\\":\\"TASK-01.md\\",\\"field\\":\\"touch\\",\\"message\\":\\"obrigatório\\"}]}'; exit 1"`]);
    const { runLint } = await load("src/plan.ts");
    const r = runLint(root, join(root, "staging"));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("TASK-01.md");
    expect(gingaCalls()).toBe("");
  });

  test("o comando recebe {dir}", async () => {
    const out = join(bin, "dir.txt");
    commands([`lint = "printf %s {dir} > ${out}"`]);
    const { runLint } = await load("src/plan.ts");
    expect(runLint(root, join(root, "meu staging")).ok).toBe(true);
    expect(readFileSync(out, "utf8")).toBe(join(root, "meu staging"));
  });

  test('"none" passa sem chamar nada', async () => {
    commands(['lint = "none"']);
    const { runLint } = await load("src/plan.ts");
    expect(runLint(root, join(root, "staging")).ok).toBe(true);
    expect(gingaCalls()).toBe("");
  });

  test("sem config, o padrão é `ginga lint <dir> --json`", async () => {
    const { runLint } = await load("src/plan.ts");
    expect(runLint(root, join(root, "staging")).ok).toBe(true);
    expect(gingaCalls().trim()).toBe(`lint ${join(root, "staging")} --json`);
  });
});
