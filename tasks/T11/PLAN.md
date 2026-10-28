---
mode: padrao
goal: "Escada free×2 → medium×2 → strong×1 automática e breaker de 3 falhas iguais (sem quota/infra) levando a blocked"
touch:
  - src/escalation.ts
  - src/run.ts
  - tests/escalation.test.ts
tests_frozen: ["tests/escalation.test.ts"]
done_when: "bun test tests/escalation.test.ts"
---
# T11: escada de tiers + breaker (PLAN-0008 TASK-04-escalada-breaker)

Materializada de `.ginga/plans/PLAN-0008-manda-routing-e-judge/TASK-04-escalada-breaker.md`.
