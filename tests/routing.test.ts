import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Contrato de `manda route <TASK> --json` (PLAN-0008 TASK-03):
 *
 * - `<TASK>` é o caminho do `TASK-*.md` (absoluto ou relativo ao `--root`); só o
 *   `tier` do frontmatter importa.
 * - `--root <dir>` (padrão cwd) é onde mora `.ginga/project.toml`.
 * - Pasta de modelos: `--models <dir>`, senão `[routing].models` do project.toml
 *   (relativo ao root), senão `$HOME/.config/ginga/models`. Lá vive o `ROUTING.md`
 *   cujo frontmatter traz `pools.executor.<tier>: [provider/model, ...]`.
 * - Saída: `{"runtime","provider","model","family","source"}`. `source` é
 *   `"project"` (pino em `[runtimes]`) ou `"routing"` (1º candidato do pool do tier).
 * - Runtime de uma entrada `provider/model` do pool: `claude`, `codex` e `agy` rodam
 *   no runtime de mesmo nome; qualquer outro provider roda no `pi`.
 * - Sem pino e sem pool: falha fechado (exit ≠ 0, stderr cita `[runtimes]`), sem padrão embutido.
 */

const ROOT = join(import.meta.dir, "..");
const MODELS = join(import.meta.dir, "fixtures", "models");

const tmps: string[] = [];
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

function workspace(projectToml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "manda-route-"));
  tmps.push(dir);
  mkdirSync(join(dir, ".ginga", "plans", "PLAN-0001-x"), { recursive: true });
  if (projectToml !== undefined) writeFileSync(join(dir, ".ginga", "project.toml"), projectToml);
  return dir;
}

function taskFile(root: string, tier: string): string {
  const p = join(root, ".ginga", "plans", "PLAN-0001-x", `TASK-01-${tier}.md`);
  writeFileSync(
    p,
    `---\ntype: task\nmode: mvp\ngoal: "g"\nplan: PLAN-0001-x\nrepo: app\ndepends_on: []\ntier: ${tier}\ntouch: [a.ts]\ndone_when: "true"\n---\n`,
  );
  return p;
}

function route(root: string, task: string, extra: string[] = [], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bun", join(ROOT, "bin", "manda.ts"), "route", task, "--json", "--root", root, ...extra], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: join(root, "home-vazia"), ...env },
  });
  const out = r.stdout.toString();
  let json: any = null;
  try {
    json = JSON.parse(out);
  } catch {}
  return { code: r.exitCode, json, out, err: r.stderr.toString() };
}

describe("manda route: pool do ROUTING pelo tier", () => {
  test("sem pino: 1º candidato do pool do tier da TASK", () => {
    const root = workspace();
    const free = route(root, taskFile(root, "free"), ["--models", join(MODELS, "primary")]);
    expect(free.code).toBe(0);
    expect(free.json).toMatchObject({
      runtime: "pi",
      provider: "opencode",
      model: "glm-5.3-flash-free",
      family: "glm",
      source: "routing",
    });
    const medium = route(root, taskFile(root, "medium"), ["--models", join(MODELS, "primary")]);
    expect(medium.json).toMatchObject({ runtime: "pi", provider: "opencode", model: "deepseek-v4-pro", family: "deepseek", source: "routing" });
  });

  test("provider claude/codex/agy roda no runtime de mesmo nome", () => {
    const root = workspace();
    const strong = route(root, taskFile(root, "strong"), ["--models", join(MODELS, "primary")]);
    expect(strong.json).toMatchObject({ runtime: "claude", provider: "claude", model: "claude-sonnet-5-5", family: "claude", source: "routing" });
    const alt = route(root, taskFile(root, "strong"), ["--models", join(MODELS, "alt")]);
    expect(alt.json).toMatchObject({ runtime: "codex", provider: "codex", model: "gpt-6-luna", family: "gpt" });
  });
});

describe("manda route: pasta de modelos", () => {
  test("--models vence [routing].models, que vence ~/.config/ginga/models", () => {
    const root = workspace(`[routing]\nmodels = "modelos-do-projeto"\n`);
    cpSync(join(MODELS, "alt"), join(root, "modelos-do-projeto"), { recursive: true });
    const home = join(root, "home-fake");
    cpSync(join(MODELS, "home"), join(home, ".config", "ginga", "models"), { recursive: true });
    const task = taskFile(root, "free");

    const cli = route(root, task, ["--models", join(MODELS, "primary")], { HOME: home });
    expect(cli.json?.model).toBe("glm-5.3-flash-free");

    const toml = route(root, task, [], { HOME: home });
    expect(toml.json?.model).toBe("nemotron-3-ultra-free");
  });

  test("sem --models nem [routing]: usa ~/.config/ginga/models", () => {
    const root = workspace();
    const home = join(root, "home-fake");
    cpSync(join(MODELS, "home"), join(home, ".config", "ginga", "models"), { recursive: true });
    const r = route(root, taskFile(root, "free"), [], { HOME: home });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ provider: "opencode", model: "deepseek-v4.1-flash-free", source: "routing" });
  });
});

describe("manda route: [runtimes] do project.toml vence o ROUTING", () => {
  test("executor fixado ignora a escada e o tier", () => {
    const root = workspace(`[runtimes]\nexecutor = "pi:opencode/deepseek-v4-pro"\n`);
    const r = route(root, taskFile(root, "free"), ["--models", join(MODELS, "primary")]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ runtime: "pi", provider: "opencode", model: "deepseek-v4-pro", family: "deepseek", source: "project" });
  });

  test("[runtimes.tier] vale só para o tier mapeado; os outros caem no ROUTING", () => {
    const root = workspace(`[runtimes.tier]\nfree = "pi:opencode/nemotron-3-ultra-free"\n`);
    const models = ["--models", join(MODELS, "primary")];
    const free = route(root, taskFile(root, "free"), models);
    expect(free.json).toMatchObject({ runtime: "pi", provider: "opencode", model: "nemotron-3-ultra-free", source: "project" });
    const medium = route(root, taskFile(root, "medium"), models);
    expect(medium.json).toMatchObject({ model: "deepseek-v4-pro", source: "routing" });
  });

  test("o pino vale mesmo sem pasta de modelos", () => {
    const root = workspace(`[runtimes]\nexecutor = "pi:opencode/glm-5.3-flash-free"\n`);
    const r = route(root, taskFile(root, "medium"));
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ provider: "opencode", model: "glm-5.3-flash-free", source: "project" });
  });
});

describe("manda route: fail-closed", () => {
  test("sem pino e sem pasta de modelos: exit ≠ 0 citando [runtimes], sem padrão embutido", () => {
    const root = workspace();
    const r = route(root, taskFile(root, "free"));
    expect(r.code).not.toBe(0);
    expect(r.json).toBeNull();
    expect(r.err).toContain("[runtimes]");
    expect(r.err + r.out).not.toContain("opencode-go");
  });

  test("tier sem candidatos no pool: exit ≠ 0", () => {
    const root = workspace();
    const r = route(root, taskFile(root, "cheap"), ["--models", join(MODELS, "primary")]);
    expect(r.code).not.toBe(0);
    expect(r.json).toBeNull();
  });
});

describe("src/family.ts: paridade com p-inga/src/family.ts", () => {
  // saídas de `modelFamily` do p-inga para cada entrada
  const casos: Array<[string, string]> = [
    ["claude-sonnet-5-5", "claude"],
    ["opus-5", "claude"],
    ["haiku-5-5", "claude"],
    ["gemma-4", "gemini"],
    ["gemini-4-argon", "gemini"],
    ["chatgpt-5", "gpt"],
    ["codex-mini", "gpt"],
    ["gpt-6-luna", "gpt"],
    ["o3", "gpt"],
    ["o3-mini", "gpt"],
    ["qwq-32b", "qwen"],
    ["qwen3.8-max", "qwen"],
    ["opencode/glm-5.3-flash-free", "glm"],
    ["opencode-go/kimi-k3.1-pro", "kimi"],
    ["us.anthropic.claude-sonnet-5-5", "claude"],
    ["mixtral-8x7b", "mistral"],
    ["Qwen2.5-Coder-7B-Q4_K_M.gguf", "qwen"],
    ["zhipu-x", "glm"],
    ["meta-llama-3", "llama"],
    ["claude-haiku:latest", "claude"],
    ["nemotron-3-ultra-free", "nemotron"],
    ["grok-4.7", "grok"],
    ["", "unknown"],
    ["  ", "unknown"],
  ];

  test("mesma família nos casos de paridade", async () => {
    let mod: any = null;
    try {
      mod = await import(join(ROOT, "src", "family.ts"));
    } catch {}
    expect(mod).not.toBeNull();
    for (const [model, esperado] of casos) {
      expect([model, mod.modelFamily(model)]).toEqual([model, esperado]);
    }
  });
});
