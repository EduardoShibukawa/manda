---
mode: padrao
goal: "O manda respeita os tetos de TASK, PLAN e mês, avisa em 80% e pede OK só ao passar do teto ou ao cair no claude"
touch:
  - src/budget.ts
  - src/run.ts
  - src/cli.ts
  - tests/budget.test.ts
tests_frozen: ["tests/budget.test.ts"]
done_when: "bun test tests/budget.test.ts"
---
# T12: tetos de budget e OK do dono (PLAN-0008 TASK-05-budget)

Materializada de `.ginga/plans/PLAN-0008-manda-routing-e-judge/TASK-05-budget.md`.
