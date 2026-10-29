import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findLlmAgent } from "../src/llm_guard";

const ROOT = join(import.meta.dir, "..");
const MANDA = join(ROOT, "bin", "manda.ts");
const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

/** Árvore /proc falsa: cada nó = [pid, ppid, argv...]. */
function fakeProc(nodes: Array<[number, number, ...string[]]>): string {
  const proc = tmp("llmguard-proc-");
  for (const [pid, ppid, ...argv] of nodes) {
    const d = join(proc, String(pid));
    mkdirSync(d);
    writeFileSync(join(d, "cmdline"), argv.join("\0") + "\0");
    writeFileSync(join(d, "stat"), `${pid} (${argv[0] ?? "x"}) S ${ppid} 1 1 0 -1 0\n`);
  }
  return proc;
}

describe("findLlmAgent: ancestral LLM (mesma lógica do merge-gate.sh)", () => {
  test("opencode run no ancestral → recusa", () => {
    const proc = fakeProc([
      [300, 200, "bun", "manda.ts", "merge"],
      [200, 100, "bash", "-c", "x"],
      [100, 1, "/usr/bin/opencode", "run", "--standalone"],
    ]);
    const r = findLlmAgent(300, proc);
    expect(r.refused).toBe(true);
    expect(r.pid).toBe(100);
  });

  test("timeout é pulado: timeout -k 5 600 opencode run", () => {
    const proc = fakeProc([
      [200, 100, "bun", "x"],
      [100, 1, "timeout", "-k", "5", "600", "opencode", "run"],
    ]);
    expect(findLlmAgent(200, proc).refused).toBe(true);
  });

  test("pi, claude -p e codex exec recusam; claude interativo não", () => {
    for (const argv of [["pi", "qualquer"], ["claude", "-p"], ["codex", "exec"]]) {
      const proc = fakeProc([[200, 100, "bun"], [100, 1, ...argv]]);
      expect(findLlmAgent(200, proc).refused).toBe(true);
    }
    const proc = fakeProc([[200, 100, "bun"], [100, 1, "claude"]]);
    expect(findLlmAgent(200, proc).refused).toBe(false);
  });

  test("lane (sem ancestral LLM) segue", () => {
    const proc = fakeProc([
      [300, 200, "bun", "manda.ts", "merge"],
      [200, 100, "bash", "lane.sh"],
      [100, 1, "systemd", "--user"],
    ]);
    expect(findLlmAgent(300, proc).refused).toBe(false);
  });
});

describe("manda merge/judge/pipeline/lane via bin/manda.ts", () => {
  /** Roda `manda <args>` sob um processo cujo argv é `opencode run` (symlink do bash + script `run`). */
  function underOpencode(args: string[]): { code: number; out: string } {
    const dir = tmp("llmguard-oc-");
    symlinkSync("/usr/bin/bash", join(dir, "opencode"));
    writeFileSync(join(dir, "run"), `${process.execPath} ${MANDA} ${args.join(" ")}\necho "EXIT:$?"\n`);
    const r = Bun.spawnSync([join(dir, "opencode"), "run"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString();
    return { code: Number(/EXIT:(\d+)/.exec(out)?.[1] ?? -1), out };
  }

  for (const args of [["merge", "P", "r", "b"], ["judge", "P", "r", "b"], ["pipeline", "x"], ["lane", "manda"]]) {
    test(`manda ${args[0]} dentro de opencode run → exit 30`, () => {
      const r = underOpencode(args);
      expect(r.code).toBe(30);
      expect(r.out).toContain("recusado");
    });
  }

  test("comando fora da lista (version) não é recusado", () => {
    const r = underOpencode(["version"]);
    expect(r.code).toBe(0);
  });

  test("sem ancestral LLM (órfão reparentado ao init) não recusa", async () => {
    const dir = tmp("llmguard-orphan-");
    const out = join(dir, "out");
    // o sh externo sai na hora; o interno vira órfão e perde o ancestral LLM desta suíte
    Bun.spawnSync(
      ["sh", "-c", `setsid sh -c 'sleep 0.5; ${process.execPath} ${MANDA} merge >${out} 2>&1; echo EXIT:$? >>${out}' </dev/null >/dev/null 2>&1 &`],
      { stdout: "pipe", stderr: "pipe" },
    );
    for (let i = 0; i < 100 && !(existsSync(out) && /EXIT:/.test(readFileSync(out, "utf8"))); i += 1) await Bun.sleep(100);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("Usage: manda merge");
    expect(text).toContain("EXIT:2");
  }, 15000);
});
