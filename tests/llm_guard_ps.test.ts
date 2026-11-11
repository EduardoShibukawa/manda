import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLlmAgent } from "../src/llm_guard";

/**
 * T912: sem /proc (macOS) a guarda lê os ancestrais pelo `ps`. A regra de
 * recusa é a mesma do /proc: opencode run, pi, claude -p, codex exec.
 */
const ROOT = join(import.meta.dir, "..");
const MANDA = join(ROOT, "bin", "manda.ts");
const SEM_PROC = "/nao/existe/proc";
const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

/** `ps` de mentira: pid → [ppid, linha de comando]. */
function fakePs(nodes: Record<number, [number, string]>) {
  return (pid: number) => (nodes[pid] ? { ppid: nodes[pid]![0], command: nodes[pid]![1] } : null);
}

describe("findLlmAgent sem /proc: cadeia pelo ps", () => {
  test("opencode run no ancestral → recusa, com o pid dele", () => {
    const ps = fakePs({ 300: [200, "bun manda.ts merge"], 200: [100, "bash -c x"], 100: [1, "/usr/local/bin/opencode run --standalone"] });
    const r = findLlmAgent(300, SEM_PROC, ps);
    expect(r.refused).toBe(true);
    expect(r.pid).toBe(100);
  });

  test("timeout com flags é pulado; pi, claude -p e codex exec recusam", () => {
    for (const command of ["timeout -k 5 600 opencode run", "pi qualquer coisa", "claude -p", "codex exec"]) {
      expect(findLlmAgent(200, SEM_PROC, fakePs({ 200: [100, "bun x"], 100: [1, command] })).refused).toBe(true);
    }
  });

  test("claude interativo e cadeia sem agente seguem", () => {
    expect(findLlmAgent(200, SEM_PROC, fakePs({ 200: [100, "bun x"], 100: [1, "claude"] })).refused).toBe(false);
    expect(findLlmAgent(200, SEM_PROC, fakePs({ 200: [100, "bun x"], 100: [1, "/bin/zsh -l"] })).refused).toBe(false);
  });

  test("ps que não responde não recusa nem trava", () => {
    expect(findLlmAgent(200, SEM_PROC, () => null).refused).toBe(false);
  });
});

describe("bin/manda.ts de verdade, neste sistema", () => {
  function underOpencode(args: string[]): { code: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), "llmguard-ps-"));
    scratch.push(dir);
    symlinkSync("/bin/sh", join(dir, "opencode"));
    // sem `exec`: o shell chamado como `opencode run` precisa continuar vivo como ancestral
    writeFileSync(join(dir, "run"), `${process.execPath} ${MANDA} ${args.join(" ")}\necho "EXIT:$?"\n`);
    const r = Bun.spawnSync([join(dir, "opencode"), "run"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString();
    return { code: Number(/EXIT:(\d+)/.exec(out)?.[1] ?? -1), out };
  }

  test("manda merge e manda judge dentro de `opencode run` → exit 30", () => {
    for (const verb of ["merge", "judge"]) {
      const r = underOpencode([verb, "PLAN-0001"]);
      expect(r.code).toBe(30);
      expect(r.out).toContain("recusado");
    }
  });

  test("comando fora da lista não é recusado", () => {
    expect(underOpencode(["version"]).code).not.toBe(30);
  });
});
