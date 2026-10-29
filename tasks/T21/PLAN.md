---
mode: padrao
goal: "Unificar src/judge-run.ts (shim) e src/judge_run.ts (implementação) num único módulo src/judge_run.ts, removendo o shim, sem mudar comportamento"
done_when: "bun test tests/judge_module.test.ts"
touch:
  - src/judge-run.ts
  - src/judge_run.ts
  - tests/judge_module.test.ts
  - tasks/T21/PLAN.md
tests_frozen: [tests/judge_module.test.ts]
---

## Context
- Refactor de limpeza: o shim `src/judge-run.ts` apenas re-exporta `./judge_run` e não é importado em nenhum lugar.
- RED: teste que falha enquanto o shim existir.