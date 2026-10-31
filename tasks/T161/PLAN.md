---
mode: padrao
goal: "manda replan monta contexto real e usa o Planner configurado com fallback"
done_when: "bun test tests/replan_cli.test.ts"
touch:
  - src/cli.ts
  - tests/replan_cli.test.ts
  - tasks/T161/PLAN.md
tests_frozen: [tests/replan_cli.test.ts]
---
