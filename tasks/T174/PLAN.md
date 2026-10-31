---
mode: mvp
repo: manda
plan: PLAN-0029-rota-de-falhas-e-disjuntor
tier: free
goal: "Antes de chamar o judge, o manda escolhe um modelo de família diferente da do executor com cota e disjuntor fechado"
done_when: "bun test tests/judge_pick.test.ts"
tests_frozen: [tests/judge_pick.test.ts]
touch: [src/judge_pick.ts, tests/judge_pick.test.ts]
pinga_task: T174
---

## Context

PLAN-0029 TASK-08. `pickJudge` pula família igual à do executor, disjuntor `open` e provider com `used_pct >= 100`. Retorna o 1º válido ou null.
