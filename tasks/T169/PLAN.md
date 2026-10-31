---
mode: mvp
goal: "Disjuntor por modelo no state.db abre 10/30/120 min, vira half_open ao vencer e fecha no sucesso"
done_when: "bun test tests/breaker.test.ts"
tests_frozen: [tests/breaker.test.ts]
touch: [src/breaker.ts, tests/breaker.test.ts]
pinga_task: T169
---

## Context

PLAN-0029 TASK-03. `breakerOf`/`recordFailure`/`recordSuccess` usam `bun:sqlite` num
`.ginga/state/state.db` (caminho injetável). Fábrica de falhas: 1ª falha → 10 min,
2ª → 30 min, 3ª → 120 min, 4ª+ capa no nível 3. `until` vencido → `half_open`.
`recordSuccess` zera. Duas instâncias `Database` no mesmo arquivo veem o mesmo estado.
