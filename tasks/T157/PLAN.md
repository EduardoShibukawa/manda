---
mode: padrao
goal: "manda replan monta o contexto determinístico e aceita o Planner somente quando o ginga lint passa"
done_when: "bun test tests/replan.test.ts"
touch:
  - src/replan.ts
  - src/cli.ts
  - tests/replan.test.ts
  - tests/fixtures/replan/expected-context.md
  - tests/fixtures/replan/task.md
  - tasks/T157/PLAN.md
tests_frozen: [tests/replan.test.ts, tests/fixtures/replan/expected-context.md, tests/fixtures/replan/task.md]
---

## Contexto
- O contexto reúne TASK, três receipts, judge, diff e LEARNINGS.
- Planner e lint são runners injetáveis; entrada igual produz bytes iguais.
