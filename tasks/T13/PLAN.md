---
mode: padrao
goal: "manda judge <PLAN> roda o Verifier Judge só com artefatos crus, em runtime de família diferente do executor e do Planner"
touch:
  - src/judge.ts
  - src/cli.ts
  - tests/judge_blind.test.ts
tests_frozen: ["tests/judge_blind.test.ts"]
done_when: "bun test tests/judge_blind.test.ts"
---
# T13: Judge cego de outra família (PLAN-0008 TASK-07-judge-cego)

Materializada de `.ginga/plans/PLAN-0008-manda-routing-e-judge/TASK-07-judge-cego.md`.
