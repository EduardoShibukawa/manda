---
type: task
mode: padrao
goal: "manda judge <PLAN> roda o Verifier Judge só com artefatos crus, em runtime de família diferente do executor e do Planner"
plan: PLAN-0008
depends_on: []
tier: medium
touch:
    - src/judge.ts
    - src/cli.ts
    - tests/judge_blind.test.ts
done_when: "bun test tests/judge_blind.test.ts"
tests_frozen: ["tests/judge_blind.test.ts"]
---
