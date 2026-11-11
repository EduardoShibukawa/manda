import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAgyRuntime, parseAgyOutput } from "../src/runtime/agy";

/**
 * T913: o juiz com o agy real em modo sem tela. Resposta vazia com ação
 * negada não é sucesso; e o pedido do juiz manda ler arquivo sem shell.
 */
const DENIED =
  '{"conversation_id":"c1","status":"SUCCESS","response":"","duration_seconds":12.7,"num_turns":1,"usage":{"input_tokens":9107,"output_tokens":999,"total_tokens":10106},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}';
const OK =
  '{"conversation_id":"c2","status":"SUCCESS","response":"{\\"verdict\\":\\"pass\\",\\"findings\\":[]}","duration_seconds":3,"num_turns":1,"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}';

describe("parseAgyOutput", () => {
  test("resposta vazia com ação negada é erro e diz qual ação", () => {
    const p = parseAgyOutput(DENIED);
    expect(p.isError).toBe(true);
    expect(p.error).toContain("RunCommand");
    expect(p.resultText).toBe("");
  });

  test("ação negada com resposta escrita continua valendo a resposta", () => {
    const withText = DENIED.replace('"response":""', '"response":"ok"');
    const p = parseAgyOutput(withText);
    expect(p.isError).toBe(false);
    expect(p.resultText).toBe("ok");
  });

  test("resposta normal não muda", () => {
    const p = parseAgyOutput(OK);
    expect(p.isError).toBe(false);
    expect(p.resultText).toContain("verdict");
  });
});

describe("runtime agy", () => {
  test("ação negada sem resposta: passed=false", async () => {
    const rt = createAgyRuntime({ spawn: async () => ({ exitCode: 0, stdout: DENIED, stderr: "", timedOut: false }) as any });
    const r = await rt.run({ worktree: "/tmp", prompt: "x", role: "judge" } as any);
    expect(r.passed).toBe(false);
    expect(r.failure).toBeDefined();
  });
});

test("o pedido do juiz manda ler com a ferramenta de arquivo, sem comando de shell", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "judge.ts"), "utf8");
  const prompt = /const prompt =\s*([\s\S]*?);\n/.exec(src)?.[1] ?? "";
  expect(prompt).toContain("file reading tool");
  expect(prompt).toMatch(/do not run (shell )?commands/i);
  expect(prompt).toContain("diff.patch");
  expect(prompt).toContain('{\\"verdict\\":\\"pass\\"|\\"fail\\"');
});
