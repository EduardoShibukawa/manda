---
mode: padrao
goal: "manda plan <INTENT|SPEC> roda o papel Planner e grava PLAN.md + TASK-*.md válidos no bundle"
touch:
  - src/plan.ts
  - src/cli.ts
  - tests/plan_cmd.test.ts
tests_frozen: ["tests/plan_cmd.test.ts"]
done_when: "bun test tests/plan_cmd.test.ts"
---
# T14: manda plan, papel Planner (PLAN-0008 TASK-08-manda-plan)

Materializada de `.ginga/plans/PLAN-0008-manda-routing-e-judge/TASK-08-manda-plan.md`.
