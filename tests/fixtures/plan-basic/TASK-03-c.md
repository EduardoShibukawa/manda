---
type: task
mode: mvp
goal: "Terceira, depende da primeira"
plan: PLAN-0001-basic
depends_on: [TASK-01-a]
tier: free
touch: [src/c.ts]
done_when: "test -f src/c.ts"
---
