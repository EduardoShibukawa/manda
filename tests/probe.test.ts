import { describe, expect, test } from "bun:test";
import { probeArgv, probe, type Runner } from "../src/probe";

const DEFAULT_TIMEOUT = 30_000;

describe("probeArgv", () => {
  test("opencode free", () => {
    expect(probeArgv("opencode/glm-5.3-flash-free")).toEqual([
      "opencode", "run", "--standalone", "--auto", "-m", "opencode/glm-5.3-flash-free", "responda só: ok",
    ]);
  });

  test("opencode-go qwen free", () => {
    const argv = probeArgv("opencode-go/qwen3.8-flash");
    expect(argv[0]).toBe("opencode");
    expect(argv[1]).toBe("run");
    expect(argv).toContain("opencode-go/qwen3.8-flash");
  });

  test("pi prefixed", () => {
    expect(probeArgv("pi:nvidia/minimax-m3.1-flash")).toEqual([
      "pi", "-p", "--model", "nvidia/minimax-m3.1-flash", "responda só: ok",
    ]);
  });

  test("claude prefixed", () => {
    const argv = probeArgv("claude/claude-sonnet-5-5");
    expect(argv[0]).toBe("claude");
    expect(argv.slice(1).join(" ")).toContain("claude-sonnet-5-5");
    expect(argv.slice(1).join(" ")).toContain("responda só: ok");
  });
});

describe("probe", () => {
  test("runner success (exit 0, saída contém ok) → ok true", async () => {
    const runner: Runner = async (_argv, _o) => ({ code: 0, stdout: "ok\nresponda só: ok" });
    const r = await probe("opencode/glm-5.3-flash-free", runner);
    expect(r.ok).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  test("runner falha (exit 1) → ok false", async () => {
    const runner: Runner = async () => ({ code: 1, stdout: "erro" });
    const r = await probe("opencode-free", runner);
    expect(r.ok).toBe(false);
  });

  test("runner timeout → ok false", async () => {
    let capturedTimeout = 0;
    const runner: Runner = async (_argv, o) => { capturedTimeout = o.timeout_ms; return { code: 124, stdout: "" }; };
    const r = await probe("opencode-free", runner, 100);
    expect(r.ok).toBe(false);
    expect(capturedTimeout).toBe(100);
  });

  test("runner ok mas sem 'ok' na saída → ok false", async () => {
    const runner: Runner = async () => ({ code: 0, stdout: "resposta qualquer" });
    const r = await probe("opencode-free", runner);
    expect(r.ok).toBe(false);
  });

  test("stdin é 'ignore' e timeout_ms passado ao runner", async () => {
    let capturedStdin: string | undefined;
    let capturedTimeout: number | undefined;
    const runner: Runner = async (_argv, o) => { capturedStdin = o.stdin; capturedTimeout = o.timeout_ms; return { code: 0, stdout: "ok" }; };
    await probe("opencode-free", runner, 5000);
    expect(capturedStdin).toBe("ignore");
    expect(capturedTimeout).toBe(5000);
  });
});
