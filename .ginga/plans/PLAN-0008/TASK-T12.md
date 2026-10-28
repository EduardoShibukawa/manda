---
type: task
mode: padrao
goal: "O manda respeita os tetos de TASK, PLAN e mês, avisa em 80% e pede OK só ao passar do teto ou ao cair no claude"
plan: PLAN-0008
depends_on: []
tier: medium
touch:
    - src/budget.ts
    - src/run.ts
    - src/cli.ts
    - tests/budget.test.ts
done_when: "bun test tests/budget.test.ts"
tests_frozen: ["tests/budget.test.ts"]
---
