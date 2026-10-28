import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PLAN = join(ROOT, "tests", "fixtures", "plan-basic");

function manda(args: string[], cwd = ROOT) {
  const r = Bun.spawnSync(["bun", join(ROOT, "bin/manda.ts"), ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "manda-bundle-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function put(rel: string, text: string) {
  const p = join(tmp, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

async function load<T>(rel: string): Promise<T | null> {
  try {
    return (await import(join(ROOT, rel))) as T;
  } catch {
    return null;
  }
}

describe("manda plan show --json", () => {
  test("devolve as TASKs em ordem topológica (não na ordem dos arquivos)", () => {
    const r = manda(["plan", "show", PLAN, "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.schema_version).toBe(1);
    expect(j.tasks.map((t: any) => t.task)).toEqual(["TASK-01-a", "TASK-03-c", "TASK-02-b"]);
  });

  test("cada TASK traz os campos do doc 04 + repo", () => {
    const j = JSON.parse(manda(["plan", "show", PLAN, "--json"]).out);
    const t1 = j.tasks.find((t: any) => t.task === "TASK-01-a");
    expect(t1).toMatchObject({
      goal: "Primeira",
      mode: "mvp",
      tier: "free",
      repo: "app",
      depends_on: [],
      touch: ["src/a.ts"],
      done_when: "test -f src/a.ts",
    });
    const t2 = j.tasks.find((t: any) => t.task === "TASK-02-b");
    expect(t2.depends_on).toEqual(["TASK-03-c"]);
    expect(t2.tests_frozen).toEqual(["tests/b.test.ts"]);
    expect(t2.tier).toBe("medium");
  });

  test("aceita o caminho do PLAN.md e o id do PLAN com --root", () => {
    const viaFile = JSON.parse(manda(["plan", "show", join(PLAN, "PLAN.md"), "--json"]).out);
    expect(viaFile.tasks.length).toBe(3);
    put(".ginga/plans/PLAN-0001-basic/PLAN.md", "---\ntype: plan\ntitle: t\nstatus: approved\ndone_when: \"true\"\n---\n");
    put(
      ".ginga/plans/PLAN-0001-basic/TASK-01-a.md",
      '---\ntype: task\nmode: mvp\ngoal: g\nplan: PLAN-0001-basic\ndepends_on: []\ntouch: [a]\ndone_when: "true"\n---\n',
    );
    const r = manda(["plan", "show", "PLAN-0001", "--root", tmp, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).tasks.map((t: any) => t.task)).toEqual(["TASK-01-a"]);
  });

  test("ciclo em depends_on: exit 1 e o ciclo na mensagem", () => {
    put("PLAN.md", "---\ntype: plan\ntitle: t\nstatus: approved\ndone_when: \"true\"\n---\n");
    const t = (n: string, dep: string) =>
      `---\ntype: task\nmode: mvp\ngoal: g\nplan: PLAN-0001-c\ndepends_on: [${dep}]\ntouch: [a]\ndone_when: "true"\n---\n`;
    put("TASK-01-a.md", t("a", "TASK-02-b"));
    put("TASK-02-b.md", t("b", "TASK-01-a"));
    const r = manda(["plan", "show", tmp, "--json"]);
    expect(r.code).toBe(1);
    const text = r.out + r.err;
    expect(text).toMatch(/cicl|cycle/i);
    expect(text).toContain("TASK-01-a");
    expect(text).toContain("TASK-02-b");
  });

  test("plan show sem argumento ou com PLAN inexistente sai com 2", () => {
    expect(manda(["plan", "show"]).code).toBe(2);
    expect(manda(["plan", "show", join(tmp, "nao-existe"), "--json"]).code).toBe(2);
  });
});

describe("leitor (módulo)", () => {
  test("não valida o bundle inteiro: campos extras e TASK sem title passam", async () => {
    put("PLAN.md", "---\ntype: plan\ntitle: t\nstatus: draft\ndone_when: \"true\"\ncampo_novo: 1\n---\n");
    put("TASK-01-a.md", '---\ntype: task\nmode: mvp\ngoal: g\nplan: x\ntouch: [a]\ndone_when: "true"\nextra: 42\n---\n');
    const r = manda(["plan", "show", tmp, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).tasks.length).toBe(1);
  });
});

describe("project.toml", () => {
  test("ausente = padrões vazios", async () => {
    const mod = await load<{ loadProject: (root: string) => any }>("src/project.ts");
    expect(mod).not.toBeNull();
    const p = mod!.loadProject(tmp);
    expect(p.commands.verify).toBeUndefined();
    expect(p.runtimes.executor).toBeUndefined();
    expect(typeof p.context).toBe("object");
  });

  test("lê [commands], [runtimes], [runtimes.tier] e [context] de .ginga/project.toml", async () => {
    put(
      ".ginga/project.toml",
      [
        "[commands]",
        'verify = "pinga verify {task} --root {repo}"',
        'test = "bun test"',
        "[context]",
        'provider = "rg"',
        "[runtimes]",
        'executor = "pi:cheap-model"',
        "[runtimes.tier]",
        'free = "pi"',
        'medium = "opencode"',
        "",
      ].join("\n"),
    );
    const mod = await load<{ loadProject: (root: string) => any }>("src/project.ts");
    expect(mod).not.toBeNull();
    const p = mod!.loadProject(tmp);
    expect(p.commands.verify).toBe("pinga verify {task} --root {repo}");
    expect(p.commands.test).toBe("bun test");
    expect(p.context.provider).toBe("rg");
    expect(p.runtimes.executor).toBe("pi:cheap-model");
    expect(p.runtimes.tier).toEqual({ free: "pi", medium: "opencode" });
  });
});
