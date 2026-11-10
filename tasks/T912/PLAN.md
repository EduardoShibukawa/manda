---
mode: padrao
goal: "a guarda de agente LLM do manda (merge, judge, pipeline, lane) funciona no macOS: sem /proc, a cadeia de ancestrais é lida pelo ps, com a mesma regra"
done_when: "bun test tests/llm_guard_ps.test.ts"
touch:
  - src/llm_guard.ts
  - tests/llm_guard_ps.test.ts
  - tasks/T912/PLAN.md
tests_frozen:
  - tests/llm_guard_ps.test.ts
---

## Contexto
- `findLlmAgent` só lia `/proc/<pid>/cmdline` e `stat`. No macOS não há `/proc`: a leitura falha em silêncio e a guarda deixa passar qualquer agente.
- O homelab (Linux) foi perdido; este Mac virou o host do gate.
- Quando o diretório do proc não existe, a cadeia vem de `ps -o ppid=,command= -p <pid>`; a regra de recusa é a mesma.
- O teste de integração usa `/bin/sh` (existe nos dois sistemas) em vez de `/usr/bin/bash`.
