import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const saved = process.env.GINGA_EVENTS;

let ws: string; // workspace (contém .ginga)
let repo: string; // repo-alvo (== ws quando a TASK não tem `repo:`)
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
  ws = realpathSync(mkdtempSync(join(tmpdir(), "manda-run-")));
  repo = ws;
  events = join(ws, "..", `events-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.GINGA_EVENTS = events;
  sh(ws, "init", "-q", "-b", "main");
  put(".gitignore", ".worktrees/\n");
  put("tests/frozen.test.ts", "// congelado\n");
  put("src/base.ts", "export {};\n");
});
afterEach(() => {
  if (saved === undefined) delete process.env.GINGA_EVENTS;
  else process.env.GINGA_EVENTS = saved;
  rmSync(ws, { recursive: true, force: true });
  rmSync(events, { force: true });
});

const PLAN = ".ginga/plans/PLAN-0001-x";

function task(name: string, o: { tier?: string; deps?: string[]; touch?: string; doneWhen?: string; frozen?: string; repo?: string } = {}) {
  put(
    `${PLAN}/${name}.md`,
    [
      "---",
      "type: task",
      "mode: mvp",
      `goal: "goal de ${name}"`,
      "plan: PLAN-0001-x",
      ...(o.repo ? [`repo: ${o.repo}`] : []),
      `depends_on: [${(o.deps ?? []).join(", ")}]`,
      `tier: ${o.tier ?? "free"}`,
      `touch: [${o.touch ?? "src/a.ts"}]`,
      `done_when: ${JSON.stringify(o.doneWhen ?? `test -f ${o.touch ?? "src/a.ts"}`)}`,
      ...(o.frozen ? [`tests_frozen: [${o.frozen}]`] : []),
      "---",
      "corpo",
    ].join("\n") + "\n",
  );
}

function setupPlan(opts: { two?: boolean; toml?: string } = {}) {
  put(`${PLAN}/PLAN.md`, '---\ntype: plan\ntitle: t\nstatus: approved\ndone_when: "true"\n---\n');
  task("TASK-01-a");
  if (opts.two) task("TASK-02-b", { tier: "medium", deps: ["TASK-01-a"], touch: "src/b.ts" });
  if (opts.toml !== undefined) put(".ginga/project.toml", opts.toml);
  sh(ws, "add", ".gitignore", ".ginga", "src", "tests");
  sh(ws, "commit", "-q", "-m", "init");
}

type Req = { worktree: string; prompt: string; model?: string; role?: string };
function stubRuntime(name: string, behavior: (req: Req) => void | Promise<void>, result: Record<string, unknown> = {}) {
  const calls: Req[] = [];
  return {
    name,
    calls,
    family: () => "stub",
    async run(req: Req) {
      calls.push(req);
      await behavior(req);
      return {
        passed: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 15 },
        costUsd: 0.001,
        model: req.model,
        ...result,
      };
    },
  };
}
const writes = (...files: string[]) => (req: Req) => {
  for (const f of files) put(f, "export {};\n", req.worktree);
};

async function runPlan(opts: Record<string, unknown>) {
  let mod: any = null;
  try {
    mod = await import(join(ROOT, "src/run.ts"));
  } catch {}
  expect(mod).not.toBeNull();
  return mod.runPlan({ root: ws, plan: "PLAN-0001", ...opts });
}

const evs = (): Record<string, any>[] =>
  (existsSync(events) ? readFileSync(events, "utf8") : "")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe("runtime por TASK", () => {
  const toml = (body: string) => body;

  test("[runtimes.tier] escolhe o runtime pelo tier da TASK", async () => {
    setupPlan({ two: true, toml: toml('[runtimes.tier]\nfree = "pi"\nmedium = "opencode"\n') });
    const pi = stubRuntime("pi", writes("src/a.ts"));
    const oc = stubRuntime("opencode", writes("src/b.ts"));
    const r = await runPlan({ resolveRuntime: (n: string) => ({ pi, opencode: oc })[n as "pi"] });
    expect(r.exitCode).toBe(0);
    expect(pi.calls.length).toBe(1);
    expect(oc.calls.length).toBe(1);
  });

  test("[runtimes].executor vence o mapa de tiers e aceita runtime:modelo", async () => {
    setupPlan({ two: true, toml: '[runtimes]\nexecutor = "claude:cheap-model"\n[runtimes.tier]\nfree = "pi"\nmedium = "opencode"\n' });
    const cl = stubRuntime("claude", (req) => writes(req.prompt.includes("TASK-02") ? "src/b.ts" : "src/a.ts")(req));
    const r = await runPlan({ resolveRuntime: (n: string) => (n === "claude" ? cl : stubRuntime(n, () => {})) });
    expect(r.exitCode).toBe(0);
    expect(cl.calls.length).toBe(2);
    expect(cl.calls.every((c) => c.model === "cheap-model")).toBe(true);
  });

  test("sem configuração o runtime é pi", async () => {
    setupPlan();
    const pi = stubRuntime("pi", writes("src/a.ts"));
    const r = await runPlan({ resolveRuntime: (n: string) => (n === "pi" ? pi : stubRuntime(n, () => {})) });
    expect(r.exitCode).toBe(0);
    expect(pi.calls.length).toBe(1);
  });
});

describe("fluxo da TASK", () => {
  test("worktree → runtime → gate → merge: o trabalho chega na main e o prompt traz TASK, touch e done_when", async () => {
    setupPlan();
    const pi = stubRuntime("pi", writes("src/a.ts"));
    const r = await runPlan({ resolveRuntime: () => pi });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(ws, "src/a.ts"))).toBe(true);
    const prompt = pi.calls[0]!.prompt;
    expect(prompt).toContain("goal de TASK-01-a");
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("test -f src/a.ts");
    expect(pi.calls[0]!.worktree).toContain(".worktrees");
  });

  test("gate falha: exit 1, attempt passed:false failure done_when, dependentes não rodam", async () => {
    setupPlan({ two: true });
    const pi = stubRuntime("pi", () => {}); // não escreve src/a.ts
    const r = await runPlan({ resolveRuntime: () => pi });
    expect(r.exitCode).toBe(1);
    expect(pi.calls.length).toBe(1);
    expect(existsSync(join(ws, "src/a.ts"))).toBe(false);
    const attempts = evs().filter((e) => e.kind === "attempt");
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.data.passed).toBe(false);
    expect(attempts[0]!.data.failure).toBe("done_when");
  });

  test("falha do runtime (quota) não chega ao gate e vira o failure do attempt", async () => {
    setupPlan();
    const pi = stubRuntime("pi", writes("src/a.ts"), { passed: false, failure: "quota_exhausted" });
    const r = await runPlan({ resolveRuntime: () => pi });
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(ws, "src/a.ts"))).toBe(false);
    expect(evs().find((e) => e.kind === "attempt")!.data.failure).toBe("quota_exhausted");
  });

  test("[commands].verify do project.toml substitui o done_when no gate", async () => {
    setupPlan({ toml: '[commands]\nverify = "test -f {worktree}/src/a.ts && test {task} = PLAN-0001/TASK-01"\n' });
    const pi = stubRuntime("pi", writes("src/a.ts"));
    const r = await runPlan({ resolveRuntime: () => pi });
    expect(r.exitCode).toBe(0);
  });

  test("tests_frozen alterado pelo executor: tentativa falha e o arquivo fica como na base", async () => {
    put(`${PLAN}/PLAN.md`, '---\ntype: plan\ntitle: t\nstatus: approved\ndone_when: "true"\n---\n');
    task("TASK-01-a", { frozen: "tests/frozen.test.ts" });
    sh(ws, "add", ".gitignore", ".ginga", "src", "tests");
    sh(ws, "commit", "-q", "-m", "init");
    const pi = stubRuntime("pi", (req) => {
      put("src/a.ts", "export {};\n", req.worktree);
      put("tests/frozen.test.ts", "// executor mexeu\n", req.worktree);
    });
    const r = await runPlan({ resolveRuntime: () => pi });
    expect(r.exitCode).toBe(1);
    expect(readFileSync(join(ws, "tests/frozen.test.ts"), "utf8")).toBe("// congelado\n");
    const a = evs().find((e) => e.kind === "attempt")!;
    expect(a.data.passed).toBe(false);
    expect(a.data.failure).toBe("done_when");
  });

  test("--task roda só a TASK pedida", async () => {
    setupPlan({ two: true });
    const pi = stubRuntime("pi", writes("src/a.ts", "src/b.ts"));
    const r = await runPlan({ task: "TASK-01-a", resolveRuntime: () => pi });
    expect(r.exitCode).toBe(0);
    expect(pi.calls.length).toBe(1);
    expect(pi.calls[0]!.prompt).toContain("goal de TASK-01-a");
  });

  test("repo: <pasta> aponta o repo-alvo dentro do workspace", async () => {
    const app = join(ws, "app");
    mkdirSync(app, { recursive: true });
    sh(app, "init", "-q", "-b", "main");
    put(".gitignore", ".worktrees/\n", app);
    put("README.md", "x\n", app);
    sh(app, "add", ".gitignore", "README.md");
    sh(app, "commit", "-q", "-m", "init");
    put(`${PLAN}/PLAN.md`, '---\ntype: plan\ntitle: t\nstatus: approved\ndone_when: "true"\n---\n');
    task("TASK-01-a", { repo: "app" });
    const pi = stubRuntime("pi", writes("src/a.ts"));
    const r = await runPlan({ resolveRuntime: () => pi });
    expect(r.exitCode).toBe(0);
    expect(pi.calls[0]!.worktree).toContain(join(app, ".worktrees"));
    expect(existsSync(join(app, "src/a.ts"))).toBe(true);
    expect(existsSync(join(ws, "src/a.ts"))).toBe(false);
  });
});

describe("eventos em $GINGA_EVENTS", () => {
  test("attempt v1 e transition por TASK, na ordem do DAG", async () => {
    setupPlan({ two: true, toml: '[runtimes.tier]\nfree = "pi"\nmedium = "opencode"\n' });
    const pi = stubRuntime("pi", writes("src/a.ts"));
    const oc = stubRuntime("opencode", writes("src/b.ts"));
    await runPlan({ resolveRuntime: (n: string) => ({ pi, opencode: oc })[n as "pi"] });
    const all = evs();
    const attempts = all.filter((e) => e.kind === "attempt");
    expect(attempts.map((e) => e.task)).toEqual(["TASK-01", "TASK-02"]);
    const a = attempts[0]!;
    expect(a.v).toBe(1);
    expect(a.source).toBe("manda");
    expect(a.plan).toBe("PLAN-0001");
    expect(a.data).toMatchObject({
      runtime: "pi",
      family: "stub",
      tier: "free",
      attempt_n: 1,
      passed: true,
      tokens_in: 10,
      tokens_out: 5,
      cost_usd: 0.001,
    });
    expect(typeof a.data.duration_ms).toBe("number");
    expect(attempts[1]!.data.runtime).toBe("opencode");
    const trans = all.filter((e) => e.kind === "transition" && e.data.entity === "task");
    expect(trans.length).toBeGreaterThanOrEqual(2);
    expect(trans.filter((e) => e.data.to === "done").map((e) => e.task)).toEqual(["TASK-01", "TASK-02"]);
  });

  test("TASK que falha termina em transition to failed", async () => {
    setupPlan();
    await runPlan({ resolveRuntime: () => stubRuntime("pi", () => {}) });
    const trans = evs().filter((e) => e.kind === "transition" && e.task === "TASK-01");
    expect(trans[trans.length - 1]!.data.to).toBe("failed");
  });

  test("sem $GINGA_EVENTS nada é escrito, só stdout", async () => {
    setupPlan();
    delete process.env.GINGA_EVENTS;
    const r = await runPlan({ resolveRuntime: () => stubRuntime("pi", writes("src/a.ts")) });
    expect(r.exitCode).toBe(0);
    expect(existsSync(events)).toBe(false);
  });
});

describe("manda run (CLI)", () => {
  function manda(args: string[]) {
    const r = Bun.spawnSync(["bun", join(ROOT, "bin/manda.ts"), ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  }

  test("sem PLAN ou com PLAN inexistente sai com 2", () => {
    expect(manda(["run"]).code).toBe(2);
    expect(manda(["run", "PLAN-9999", "--root", ws]).code).toBe(2);
  });

  test("runtime ausente do PATH: attempt falho infra, exit 1, e ainda imprime em stdout", () => {
    setupPlan({ toml: '[runtimes]\nexecutor = "pi"\n' });
    const r = Bun.spawnSync([process.execPath, join(ROOT, "bin/manda.ts"), "run", "PLAN-0001", "--root", ws], {
      cwd: ROOT,
      env: { ...process.env, PATH: "/usr/bin:/bin", GINGA_EVENTS: events },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout.toString()).toContain("TASK-01");
    const a = evs().find((e) => e.kind === "attempt")!;
    expect(a.data.passed).toBe(false);
    expect(a.data.failure).toBe("infra");
  });
});
