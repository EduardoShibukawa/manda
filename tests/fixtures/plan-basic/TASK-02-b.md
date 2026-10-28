---
type: task
mode: padrao
goal: "Segunda, depende da terceira"
plan: PLAN-0001-basic
depends_on: [TASK-03-c]
tier: medium
touch: [src/b.ts, tests/b.test.ts]
done_when: "test -f src/b.ts"
tests_frozen: [tests/b.test.ts]
---
