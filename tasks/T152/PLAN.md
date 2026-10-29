---
mode: padrao
goal: "O adapter pi devolve em resultText o texto da última mensagem do assistente, não o NDJSON cru"
done_when: "bun test tests/runtime_pi_text.test.ts tests/runtime_pi_opencode.test.ts"
touch:
  - src/runtime/pi.ts
  - tests/runtime_pi_text.test.ts
  - tasks/T152/PLAN.md
tests_frozen: [tests/runtime_pi_text.test.ts]
---

## Contexto
- `src/runtime/pi.ts` hoje faz `resultText: raw.stdout` (NDJSON do `pi --mode json`); com o pi real o
  `manda plan` não acha `=== FILE: ... ===` no começo de linha (o texto vem JSON-escapado).
- Fazer: no `message_end` com `role: "assistant"`, juntar os `content[].text` (type text) da ÚLTIMA mensagem
  do assistente e usar como `resultText`; sem nenhuma, manter `raw.stdout`. `stdout` continua cru.
- Não mexer em `parsePiRunnerOutput` além do necessário; os testes de `runtime_pi_opencode` seguem verdes.
