import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FIX = join(ROOT, "tests", "fixtures", "runtime");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");

type Raw = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };

function stub(raw: Raw) {
  const calls: Array<{ cmd: string[]; cwd: string }> = [];
  const spawn = async (cmd: string[], o: { cwd: string }) => {
    calls.push({ cmd, cwd: o.cwd });
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

const REQ = { worktree: "/tmp/wt-y", prompt: "faça o trabalho", model: "claude-sonnet-5-5", timeoutMs: 9000 };

describe("claude", () => {
  test("sucesso: passed, usage somado, custo, modelo de maior volume e args do host", async () => {
    const mod = await load("src/runtime/claude.ts");
    expect(mod).not.toBeNull();
    const s = stub({ exitCode: 0, stdout: fixture("claude-ok.json"), stderr: "" });
    const rt = mod!.createClaudeRuntime({ spawn: s.spawn });
    expect(rt.name).toBe("claude");
    expect(rt.family("claude-opus-5-5")).toBe("claude");
    const r = await rt.run(REQ);
    expect(r.passed).toBe(true);
    expect(r.usage.totalTokens).toBe(1550);
    expect(r.costUsd).toBeCloseTo(0.0123, 6);
    expect(r.model).toBe("claude-sonnet-5-5");
    const cmd = s.calls[0]!.cmd;
    expect(cmd[0]).toBe("claude");
    expect(cmd).toContain("-p");
    expect(cmd).toContain("faça o trabalho");
    expect(cmd.join(" ")).toContain("--output-format json");
    expect(cmd.join(" ")).toContain("--model claude-sonnet-5-5");
    expect(s.calls[0]!.cwd).toBe("/tmp/wt-y");
  });

  test("is_error:true → passed false, failure infra", async () => {
    const mod = await load("src/runtime/claude.ts");
    expect(mod).not.toBeNull();
    const r = await mod!.createClaudeRuntime({ spawn: stub({ exitCode: 0, stdout: fixture("claude-error.json"), stderr: "" }).spawn }).run(REQ);
    expect(r.passed).toBe(false);
    expect(r.failure).toBe("infra");
  });

  test("parseClaudeOutput: texto puro vira erro", async () => {
    const mod = await load("src/runtime/claude.ts");
    expect(mod).not.toBeNull();
    expect(mod!.parseClaudeOutput("Segmentation fault").isError).toBe(true);
    expect(mod!.parseClaudeOutput("").isError).toBe(false);
  });
});

describe("agy", () => {
  test("sucesso (fixture real): usage e tempo", async () => {
    const mod = await load("src/runtime/agy.ts");
    expect(mod).not.toBeNull();
    const s = stub({ exitCode: 0, stdout: fixture("agy-success.json"), stderr: "" });
    const rt = mod!.createAgyRuntime({ spawn: s.spawn });
    expect(rt.name).toBe("agy");
    const r = await rt.run({ ...REQ, model: undefined });
    expect(r.passed).toBe(true);
    expect(r.usage.totalTokens).toBe(6732);
    const cmd = s.calls[0]!.cmd;
    expect(cmd[0]).toBe("agy");
    expect(cmd.slice(0, 2)).toEqual(["--print", "faça o trabalho"]);
    expect(cmd).toContain("--model");
  });

  test("modelo inválido (fixture real) → passed false, infra", async () => {
    const mod = await load("src/runtime/agy.ts");
    expect(mod).not.toBeNull();
    const r = await mod!.createAgyRuntime({ spawn: stub({ exitCode: 0, stdout: fixture("agy-invalid-model.json"), stderr: "" }).spawn }).run(REQ);
    expect(r.passed).toBe(false);
    expect(r.failure).toBe("infra");
  });

  test("papéis que não editam rodam com --mode plan; executor não", async () => {
    const mod = await load("src/runtime/agy.ts");
    expect(mod).not.toBeNull();
    const ok: Raw = { exitCode: 0, stdout: fixture("agy-success.json"), stderr: "" };
    const j = stub(ok);
    await mod!.createAgyRuntime({ spawn: j.spawn }).run({ ...REQ, role: "judge" });
    expect(j.calls[0]!.cmd.join(" ")).toContain("--mode plan");
    const e = stub(ok);
    await mod!.createAgyRuntime({ spawn: e.spawn }).run({ ...REQ, role: "executor" });
    expect(e.calls[0]!.cmd.join(" ")).not.toContain("--mode plan");
  });
});

describe("codex: recusado como executor", () => {
  const okRaw = (): Raw => ({ exitCode: 0, stdout: fixture("codex-ok.jsonl"), stderr: "" });

  test("sem PI_CODEX_ENABLED=1 nenhum papel roda: processo não é iniciado", async () => {
    const mod = await load("src/runtime/codex.ts");
    expect(mod).not.toBeNull();
    for (const role of ["executor", "worker", "judge", undefined]) {
      const s = stub(okRaw());
      const r = await mod!.createCodexRuntime({ spawn: s.spawn }).run({ ...REQ, role, env: {} });
      expect(r.passed).toBe(false);
      expect(r.refusal).toBe("disabled");
      expect(s.calls.length).toBe(0);
    }
  });

  test("com PI_CODEX_ENABLED=1, executor/worker/sem papel seguem recusados", async () => {
    const mod = await load("src/runtime/codex.ts");
    expect(mod).not.toBeNull();
    for (const role of ["executor", "worker", undefined]) {
      const s = stub(okRaw());
      const r = await mod!.createCodexRuntime({ spawn: s.spawn }).run({ ...REQ, role, env: { PI_CODEX_ENABLED: "1" } });
      expect(r.passed).toBe(false);
      expect(r.refusal).toBe("role_forbidden");
      expect(r.failure).toBe("infra");
      expect(s.calls.length).toBe(0);
    }
  });

  test("planner, reviewer e judge rodam (cota de assinatura: custo 0, usage sem dupla contagem do cache)", async () => {
    const mod = await load("src/runtime/codex.ts");
    expect(mod).not.toBeNull();
    for (const role of ["planner", "reviewer", "judge"]) {
      const s = stub(okRaw());
      const rt = mod!.createCodexRuntime({ spawn: s.spawn });
      expect(rt.name).toBe("codex");
      const r = await rt.run({ ...REQ, model: "gpt-6-luna", role, env: { PI_CODEX_ENABLED: "1" } });
      expect(r.passed).toBe(true);
      expect(r.costUsd).toBe(0);
      expect(r.usage.totalTokens).toBe(1070);
      const cmd = s.calls[0]!.cmd;
      expect(cmd.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
      expect(cmd).toContain("gpt-6-luna");
    }
  });

  test("turn.failed → passed false, infra", async () => {
    const mod = await load("src/runtime/codex.ts");
    expect(mod).not.toBeNull();
    const s = stub({ exitCode: 0, stdout: fixture("codex-turn-failed.jsonl"), stderr: "" });
    const r = await mod!.createCodexRuntime({ spawn: s.spawn }).run({ ...REQ, role: "judge", env: { PI_CODEX_ENABLED: "1" } });
    expect(r.passed).toBe(false);
    expect(r.failure).toBe("infra");
  });

  test("checkCodexContract: ordem disabled → role_forbidden → prompt_too_large", async () => {
    const mod = await load("src/runtime/codex.ts");
    expect(mod).not.toBeNull();
    const c = mod!.checkCodexContract;
    expect(c({ enabled: false, role: "judge", promptChars: 10, maxPromptTokens: 100 })).toMatchObject({ ok: false, kind: "disabled" });
    expect(c({ enabled: true, role: "worker", promptChars: 10, maxPromptTokens: 100 })).toMatchObject({ ok: false, kind: "role_forbidden" });
    expect(c({ enabled: true, role: "judge", promptChars: 4001, maxPromptTokens: 1000 })).toMatchObject({ ok: false, kind: "prompt_too_large" });
    expect(c({ enabled: true, role: "judge", promptChars: 40, maxPromptTokens: 1000 })).toEqual({ ok: true });
  });
});

describe("resolveRuntime", () => {
  test("devolve o adapter pelo nome e falha para nome desconhecido", async () => {
    const idx = await load("src/runtime/index.ts");
    expect(idx).not.toBeNull();
    for (const name of ["pi", "opencode", "claude", "codex", "agy"]) {
      expect(idx!.resolveRuntime(name).name).toBe(name);
    }
    expect(() => idx!.resolveRuntime("banana")).toThrow(/banana/);
  });
});
