import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const FIX = join(ROOT, "tests", "fixtures", "runtime");

let ws: string;
let bin: string;
let log: string;
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

/**
 * Stub de runtime: registra a invocação (nome, cwd, args), escreve o arquivo do
 * `touch` e imprime uma saída gravada no formato real do runtime.
 */
function stubBin(name: string, writes: string, fixtureFile: string) {
  const p = join(bin, name);
  writeFileSync(
    p,
    [
      "#!/bin/sh",
      `printf '%s\\t%s\\t%s\\n' "${name}" "$PWD" "$*" >> "${log}"`,
      `mkdir -p "$(dirname "${writes}")" && echo 'export {};' > "${writes}"`,
      `cat "${join(FIX, fixtureFile)}"`,
      "",
    ].join("\n"),
  );
  chmodSync(p, 0o755);
}

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "manda-e2e-")));
  bin = join(ws, "..", `stubs-${Math.random().toString(36).slice(2)}`);
  mkdirSync(bin, { recursive: true });
  log = join(bin, "calls.log");
  events = join(bin, "events.jsonl");
  sh(ws, "init", "-q", "-b", "main");
  put(".gitignore", ".worktrees/\n");
  put("src/base.ts", "export {};\n");
  const plan = ".ginga/plans/PLAN-0001-dois-runtimes";
  put(`${plan}/PLAN.md`, '---\ntype: plan\ntitle: dois runtimes\nstatus: approved\ndone_when: "test -f src/a.ts && test -f src/b.ts"\n---\n');
  const task = (n: string, tier: string, file: string, deps = "") =>
    put(
      `${plan}/${n}.md`,
      `---\ntype: task\nmode: mvp\ngoal: "cria ${file}"\nplan: PLAN-0001-dois-runtimes\ndepends_on: [${deps}]\ntier: ${tier}\ntouch: [${file}]\ndone_when: "test -f ${file}"\n---\n`,
    );
  task("TASK-01-a", "free", "src/a.ts");
  task("TASK-02-b", "medium", "src/b.ts", "TASK-01-a");
  put(".ginga/project.toml", '[runtimes.tier]\nfree = "pi"\nmedium = "opencode"\n');
  sh(ws, "add", ".gitignore", ".ginga", "src");
  sh(ws, "commit", "-q", "-m", "init");
  // cada stub escreve o arquivo no cwd (o worktree da TASK), então o caminho é relativo
  stubBin("pi", "src/a.ts", "pi-ok.jsonl");
  stubBin("opencode", "src/b.ts", "opencode-ok.jsonl");
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

describe("um PLAN, dois runtimes, fora do Pi", () => {
  function run() {
    return Bun.spawnSync([process.execPath, join(ROOT, "bin/manda.ts"), "run", "PLAN-0001", "--root", ws], {
      cwd: ROOT,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GINGA_EVENTS: events },
      stdout: "pipe",
      stderr: "pipe",
    });
  }
  const evs = (): Record<string, any>[] =>
    (existsSync(events) ? readFileSync(events, "utf8") : "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const calls = (): string[][] =>
    (existsSync(log) ? readFileSync(log, "utf8") : "")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t"));

  test("exit 0, as duas TASKs passam no gate e o trabalho chega na main", () => {
    const r = run();
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(ws, "src/a.ts"))).toBe(true);
    expect(existsSync(join(ws, "src/b.ts"))).toBe(true);
  });

  test("dois attempt com runtime diferente e passed true", () => {
    run();
    const attempts = evs().filter((e) => e.kind === "attempt");
    expect(attempts.map((e) => e.data.runtime)).toEqual(["pi", "opencode"]);
    expect(attempts.every((e) => e.data.passed === true)).toBe(true);
    expect(attempts.every((e) => e.source === "manda" && e.v === 1)).toBe(true);
    expect(attempts[0]!.data.tokens_in).toBeGreaterThan(0);
  });

  test("cada runtime é subprocesso no worktree da TASK; o pi roda como runtime (--mode json -p), nunca como host", () => {
    run();
    const c = calls();
    expect(c.map((x) => x[0])).toEqual(["pi", "opencode"]);
    for (const [, cwd] of c) expect(cwd).toContain(join(ws, ".worktrees"));
    expect(c[0]![2]).toContain("--mode json");
    expect(c[0]![2]).toContain("-p ");
    expect(c[1]![2]).toContain("run --standalone");
  });

  test("a ordem do DAG vale: TASK-02 só roda depois da TASK-01", () => {
    run();
    const t = evs()
      .filter((e) => e.kind === "transition" && e.data.to === "done")
      .map((e) => e.task);
    expect(t).toEqual(["TASK-01", "TASK-02"]);
  });
});
