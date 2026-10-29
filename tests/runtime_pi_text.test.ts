import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * PLAN-0009 TASK-09: o `resultText` do adapter pi é o texto da última mensagem do assistente (não o NDJSON cru),
 * senão `manda plan` não acha os blocos `=== FILE: ... ===` na resposta do Planner. `stdout` segue cru.
 */
const ROOT = join(import.meta.dir, "..");
const REQ = { worktree: "/tmp/wt-x", prompt: "p", model: "qwen3.8-flash", provider: "opencode", timeoutMs: 5000 };
const run = async (stdout: string) => {
  const { createPiRuntime } = await import(join(ROOT, "src/runtime/pi.ts"));
  return createPiRuntime({ spawn: async () => ({ exitCode: 0, stdout, stderr: "" }) }).run(REQ);
};
const msg = (role: string, ...texts: string[]) =>
  JSON.stringify({ type: "message_end", message: { role, content: texts.map((text) => ({ type: "text", text })), usage: { input: 1, output: 1 }, stopReason: "stop" } });

describe("pi: resultText", () => {
  test("fixture real: resultText é o texto do assistente, stdout continua cru", async () => {
    const raw = readFileSync(join(ROOT, "tests/fixtures/runtime/pi-ok.jsonl"), "utf8");
    const r = await run(raw);
    expect(r.resultText).toBe("OK");
    expect(r.stdout).toBe(raw);
  });

  test("texto multilinha com blocos === FILE === sai com as quebras de linha reais, da última mensagem do assistente", async () => {
    const reply = "=== FILE: PLAN.md ===\n---\ntype: plan\n---\n=== FILE: TASK-01-a.md ===\n---\ntype: task\n---\n";
    const raw = [msg("assistant", "rascunho"), msg("user", "ignorado"), msg("assistant", reply)].join("\n") + "\n";
    const r = await run(raw);
    expect(r.resultText).toBe(reply);
    expect(r.resultText).toMatch(/^=== FILE: PLAN\.md ===$/m);
  });

  test("sem message_end do assistente: resultText cai no stdout", async () => {
    const raw = '{"type":"agent_start"}\nsaída solta\n';
    const r = await run(raw);
    expect(r.resultText).toBe(raw);
  });
});
