---
mode: mvp
repo: manda
plan: PLAN-0029-rota-de-falhas-e-disjuntor
tier: free
goal: "pickModel escolhe o free saudável de qualquer provider antes de qualquer pago, e o pago só com todos os free abertos, ALLOW_PAID e teto ok"
done_when: "bun test tests/ladder.test.ts"
tests_frozen: [tests/ladder.test.ts]
touch: [src/ladder.ts, tests/ladder.test.ts]
pinga_task: T172
---

## Context

PLAN-0029 TASK-04. `pickModel` itera a lista `free` (pulando breakers
`open`), pula `iceman*` quando `mitRepo: false`, e só após esgotar free
usa o pool do `tier` quando `allowPaid && capOk`. Nada disponível → null.
