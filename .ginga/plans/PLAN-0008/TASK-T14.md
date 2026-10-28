---
type: task
mode: padrao
goal: "manda plan <INTENT|SPEC> roda o papel Planner e grava PLAN.md + TASK-*.md válidos no bundle"
plan: PLAN-0008
depends_on: []
tier: medium
touch:
    - src/plan.ts
    - src/cli.ts
    - tests/plan_cmd.test.ts
done_when: "bun test tests/plan_cmd.test.ts"
tests_frozen: ["tests/plan_cmd.test.ts"]
---
