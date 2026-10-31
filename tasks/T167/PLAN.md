---
mode: mvp
goal: "classifyRun distingue devagar, na_fila, travado e recusado a partir de observações da tentativa, sem relógio fixo"
done_when: "bun test tests/run_state.test.ts"
tests_frozen: [tests/run_state.test.ts]
touch: [src/run_state.ts, tasks/T167/PLAN.md]
pinga_task: T167
---

## Context

- Primeira TASK do PLAN-0029 (rota de falhas). `classifyRun` substitui o timeout fixo: classifica a tentativa em 4 estados a partir de observações.
