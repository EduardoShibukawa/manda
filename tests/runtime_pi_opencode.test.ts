import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FIX = join(ROOT, "tests", "fixtures", "runtime");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");
// mesma fixture sintética, sem as linhas step_finish (onde ficam tokens e custo)
const semStepFinish = (name: string) =>
  fixture(name)
    .split("\n")
    .filter((l) => !l.includes('"step_finish"'))
    .join("\n");

type Raw = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };
type Call = { cmd: string[]; cwd: string; env?: Record<string, string>; timeoutMs?: number };

function stub(raw: Raw) {
  const calls: Call[] = [];
  const spawn = async (cmd: string[], o: { cwd: string; env?: Record<string, string>; timeoutMs?: number }) => {
    calls.push({ cmd, ...o });
    return raw;
  };
  return { spawn, calls };
}

async function load<T = any>(rel: string): Promise<T | null> {
  try {
    return (await import(join(ROOT, rel))) as T;
  } catch {
    return null;
  }
}

const REQ = { worktree: "/tmp/wt-x", prompt: "crie src/x.ts", model: "qwen3.8-flash", provider: "opencode", timeoutMs: 5000 };

describe("runtime port", () => {
  test("FAILURES lista exatamente o vocabulário do 07", async () => {
    const port = await load("src/runtime/port.ts");
    expect(port).not.toBeNull();
    expect([...port!.FAILURES]).toEqual(["done_when", "quota_exhausted", "timeout", "infra", "judge"]);
  });

  test("os adapters expõem name e family(model)", async () => {
    const pi = await load("src/runtime/pi.ts");
    const oc = await load("src/runtime/opencode.ts");
    expect(pi).not.toBeNull();
    expect(oc).not.toBeNull();
    const a = pi!.createPiRuntime();
    const b = oc!.createOpenCodeRuntime();
    expect(a.name).toBe("pi");
    expect(b.name).toBe("opencode");
    expect(a.family("qwen3.8-flash")).toBe("qwen");
    expect(a.family("deepseek-v4-pro")).toBe("deepseek");
    expect(b.family("claude-sonnet-5-5")).toBe("claude");
    expect(a.family("")).toBe("unknown");
  });
});

describe("classifyRunnerFailure (portado)", () => {
  const cases: Array<[string, string]> = [
    ["429 rate limit exceeded", "quota_exhausted"],
    ["free usage limit reached", "quota_exhausted"],
    ["401 unauthorized", "unauthorized"],
    ["403: FreeTierError", "unauthorized"],
    ["404 model not found", "not_found"],
    ["TaskRunner Timeout (5000ms) exceeded.", "timeout"],
    ["502 bad gateway", "server_error"],
    ["", "unknown"],
    ["algo estranho", "unknown"],
  ];
  test("tabela de classes", async () => {
    const mod = await load("src/runtime/failure.ts");
    expect(mod).not.toBeNull();
    for (const [stderr, esperado] of cases) {
      expect(mod!.classifyRunnerFailure({ exitCode: 1, stderr })).toBe(esperado);
    }
  });
});

describe("parsePiRunnerOutput (fixtures reais do pi)", () => {
  test("extrai usage e custo reportado pelo pi", async () => {
    const mod = await load("src/runtime/pi.ts");
    expect(mod).not.toBeNull();
    const out = mod!.parsePiRunnerOutput(fixture("pi-ok.jsonl"));
    expect(out.usage).toMatchObject({ inputTokens: 511, outputTokens: 24, totalTokens: 535 });
    expect(out.costUsd).toBeCloseTo(8.793e-5, 8);
    expect(out.stopReason).toBe("stop");
    expect(out.apiError).toBe(false);
  });

  test("stopReason error sem stop vira apiError", async () => {
    const mod = await load("src/runtime/pi.ts");
    expect(mod).not.toBeNull();
    expect(mod!.parsePiRunnerOutput(fixture("pi-free-tier-403.jsonl")).apiError).toBe(true);
  });
});

describe("runtime pi (spawn injetado)", () => {
  test("sucesso: passed, usage, custo e stdout; spawn no worktree com o prompt", async () => {
    const mod = await load("src/runtime/pi.ts");
    expect(mod).not.toBeNull();
    const s = stub({ exitCode: 0, stdout: fixture("pi-ok.jsonl"), stderr: "" });
    const r = await mod!.createPiRuntime({ spawn: s.spawn }).run(REQ);
    expect(r.passed).toBe(true);
    expect(r.failure).toBeUndefined();
    expect(r.usage.totalTokens).toBe(535);
    expect(r.costUsd).toBeCloseTo(8.793e-5, 8);
    expect(r.stdout).toBe(fixture("pi-ok.jsonl"));
    expect(s.calls.length).toBe(1);
    expect(s.calls[0]!.cmd[0]).toBe("pi");
    expect(s.calls[0]!.cwd).toBe("/tmp/wt-x");
    expect(s.calls[0]!.cmd).toContain("crie src/x.ts");
    expect(s.calls[0]!.cmd).toContain("qwen3.8-flash");
    expect(s.calls[0]!.timeoutMs).toBe(5000);
  });

  test("pi sai 0 mesmo com erro de API: 403 do free tier → infra", async () => {
    const mod = await load("src/runtime/pi.ts");
    expect(mod).not.toBeNull();
    const s = stub({ exitCode: 0, stdout: fixture("pi-free-tier-403.jsonl"), stderr: "" });
    const r = await mod!.createPiRuntime({ spawn: s.spawn }).run(REQ);
    expect(r.passed).toBe(false);
    expect(r.failure).toBe("infra");
  });

  test("429 no stream → quota_exhausted", async () => {
    const mod = await load("src/runtime/pi.ts");
    expect(mod).not.toBeNull();
    const s = stub({ exitCode: 0, stdout: fixture("pi-quota-429.jsonl"), stderr: "" });
    const r = await mod!.createPiRuntime({ spawn: s.spawn }).run(REQ);
    expect(r.passed).toBe(false);
    expect(r.failure).toBe("quota_exhausted");
  });

  test("timeout do spawn → timeout; saída ≠ 0 sem pista → infra", async () => {
    const mod = await load("src/runtime/pi.ts");
    expect(mod).not.toBeNull();
    const t = await mod!
      .createPiRuntime({ spawn: stub({ exitCode: 143, stdout: "", stderr: "TaskRunner Timeout (5000ms) exceeded.", timedOut: true }).spawn })
      .run(REQ);
    expect(t.passed).toBe(false);
    expect(t.failure).toBe("timeout");
    const i = await mod!.createPiRuntime({ spawn: stub({ exitCode: 1, stdout: "", stderr: "segfault" }).spawn }).run(REQ);
    expect(i.passed).toBe(false);
    expect(i.failure).toBe("infra");
  });

  test("bin configurável", async () => {
    const mod = await load("src/runtime/pi.ts");
    expect(mod).not.toBeNull();
    const s = stub({ exitCode: 0, stdout: fixture("pi-ok.jsonl"), stderr: "" });
    await mod!.createPiRuntime({ spawn: s.spawn, bin: "/opt/pi" }).run(REQ);
    expect(s.calls[0]!.cmd[0]).toBe("/opt/pi");
  });
});

describe("runtime opencode (spawn injetado)", () => {
  test("parseOpenCodeOutput soma tokens do step_finish, texto, custo e sessionID", async () => {
    const mod = await load("src/runtime/opencode.ts");
    expect(mod).not.toBeNull();
    const p = mod!.parseOpenCodeOutput(fixture("opencode-ok.jsonl"));
    expect(p.resultText).toBe("DONE");
    expect(p.isError).toBe(false);
    expect(p.sessionId).toBe("ses_fix1");
    expect(p.costUsd).toBeCloseTo(0.0021, 6);
    expect(p.usage).toMatchObject({ inputTokens: 3938, outputTokens: 67, cacheReadTokens: 4096, totalTokens: 8101 });
  });

  test("sem step_finish: tokens e custo desconhecidos (null), sem quebrar", async () => {
    const mod = await load("src/runtime/opencode.ts");
    expect(mod).not.toBeNull();
    const raw = semStepFinish("opencode-ok.jsonl");
    expect(raw).not.toContain("step_finish");
    const p = mod!.parseOpenCodeOutput(raw);
    expect(p.resultText).toBe("DONE");
    expect(p.isError).toBe(false);
    expect(p.sessionId).toBe("ses_fix1");
    expect(p.costUsd ?? null).toBeNull();
    expect(p.usage ?? null).toBeNull();
  });

  test("captura real do opencode (só step_start + text, sem step_finish): lê o texto, uso e custo null", async () => {
    const mod = await load("src/runtime/opencode.ts");
    expect(mod).not.toBeNull();
    const real = fixture("real/opencode-ok.jsonl");
    expect(real).not.toContain("step_finish");
    const p = mod!.parseOpenCodeOutput(real);
    expect(p.resultText).toBe("ok");
    expect(p.isError).toBe(false);
    expect(p.sessionId).toBe("ses_e81073870ffe3vp1fbRc9bTiCJ");
    expect(p.costUsd ?? null).toBeNull();
    expect(p.usage ?? null).toBeNull();

    const s = stub({ exitCode: 0, stdout: real, stderr: "" });
    const r = await mod!.createOpenCodeRuntime({ spawn: s.spawn }).run(REQ);
    expect(r.passed).toBe(true);
    expect(r.failure).toBeUndefined();
    expect(r.costUsd ?? null).toBeNull();
    expect(r.usage ?? null).toBeNull();
    expect(r.stdout).toBe(real);
  });

  test("sucesso: args run --standalone --auto --format json -m provider/model e o prompt", async () => {
    const mod = await load("src/runtime/opencode.ts");
    expect(mod).not.toBeNull();
    const s = stub({ exitCode: 0, stdout: fixture("opencode-ok.jsonl"), stderr: "" });
    const r = await mod!.createOpenCodeRuntime({ spawn: s.spawn }).run({ ...REQ, model: "deepseek-v4.1-flash-free" });
    expect(r.passed).toBe(true);
    expect(r.usage.totalTokens).toBe(8101);
    const cmd = s.calls[0]!.cmd;
    expect(cmd[0]).toBe("opencode");
    expect(cmd.slice(1, 7)).toEqual(["run", "--standalone", "--auto", "--format", "json", "-m"]);
    expect(cmd).toContain("opencode/deepseek-v4.1-flash-free");
    expect(cmd[cmd.length - 1]).toBe("crie src/x.ts");
    expect(s.calls[0]!.cwd).toBe("/tmp/wt-x");
  });

  test("evento error com 429 → quota_exhausted; sem pista → infra", async () => {
    const mod = await load("src/runtime/opencode.ts");
    expect(mod).not.toBeNull();
    const q = await mod!
      .createOpenCodeRuntime({ spawn: stub({ exitCode: 0, stdout: fixture("opencode-error-429.jsonl"), stderr: "" }).spawn })
      .run(REQ);
    expect(q.passed).toBe(false);
    expect(q.failure).toBe("quota_exhausted");
    const i = await mod!
      .createOpenCodeRuntime({ spawn: stub({ exitCode: 2, stdout: "", stderr: "crash" }).spawn })
      .run(REQ);
    expect(i.passed).toBe(false);
    expect(i.failure).toBe("infra");
  });
});

describe("sem dependência do Pi", () => {
  test("src/runtime não importa @earendil-works nem o HUD", () => {
    const r = Bun.spawnSync(
      ["grep", "-rEn", "(import|require).*(@earendil-works|hud/controls|pi-coding-agent)", "src"],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(r.stdout.toString().trim()).toBe("");
  });
});

describe("runtime pi fail-closed (sem provider/modelo padrão)", () => {
  // Falhar fechado vale como resultado `passed: false` ou como exceção; nos dois casos
  // o `pi` não pode ser spawnado e a mensagem precisa apontar onde configurar a rota.
  async function tentar(req: Record<string, unknown>) {
    const mod = await load("src/runtime/pi.ts");
    expect(mod).not.toBeNull();
    const s = stub({ exitCode: 0, stdout: fixture("pi-ok.jsonl"), stderr: "" });
    let passed: boolean | undefined;
    let msg = "";
    try {
      const r = await mod!.createPiRuntime({ spawn: s.spawn }).run({ worktree: "/tmp/wt-x", prompt: "crie src/x.ts", timeoutMs: 5000, ...req });
      passed = r.passed;
      msg = [r.stderr, r.resultText, r.stdout].filter(Boolean).join("\n");
    } catch (e) {
      passed = false;
      msg = String((e as Error)?.message ?? e);
    }
    return { s, passed, msg };
  }

  test("sem provider e sem modelo: não spawna o pi e cita [runtimes]/project.toml", async () => {
    const { s, passed, msg } = await tentar({});
    expect(passed).toBe(false);
    expect(s.calls.length).toBe(0);
    expect(msg).toMatch(/\[runtimes\]|project\.toml/);
  });

  test("só provider ou só modelo também falham fechado", async () => {
    const a = await tentar({ provider: "opencode" });
    expect(a.passed).toBe(false);
    expect(a.s.calls.length).toBe(0);
    expect(a.msg).toMatch(/\[runtimes\]|project\.toml/);
    const b = await tentar({ model: "qwen3.8-flash" });
    expect(b.passed).toBe(false);
    expect(b.s.calls.length).toBe(0);
    expect(b.msg).toMatch(/\[runtimes\]|project\.toml/);
  });

  test("a mensagem não sugere opencode-go nem modelo padrão", async () => {
    const { msg } = await tentar({});
    expect(msg).not.toContain("opencode-go");
    expect(msg).not.toContain("qwen3.8-flash");
  });

  test("com provider e modelo explícitos, passa os dois ao pi", async () => {
    const { s, passed } = await tentar({ provider: "opencode", model: "deepseek-v4.1-flash-free" });
    expect(passed).toBe(true);
    expect(s.calls.length).toBe(1);
    const cmd = s.calls[0]!.cmd;
    expect(cmd[cmd.indexOf("--provider") + 1]).toBe("opencode");
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("deepseek-v4.1-flash-free");
  });

  test("src/runtime/pi.ts não contém opencode-go nem qwen3.8-flash como padrão", () => {
    const src = readFileSync(join(ROOT, "src", "runtime", "pi.ts"), "utf8");
    expect(src).not.toContain("opencode-go");
    expect(src).not.toContain("qwen3.8-flash");
  });
});
