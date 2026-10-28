---
type: task
mode: padrao
goal: "Escada free×2 → medium×2 → strong×1 automática e breaker de 3 falhas iguais (sem quota/infra) levando a blocked"
plan: PLAN-0008
depends_on: []
tier: medium
touch:
    - src/escalation.ts
    - src/run.ts
    - tests/escalation.test.ts
done_when: "bun test tests/escalation.test.ts"
tests_frozen: ["tests/escalation.test.ts"]
---
