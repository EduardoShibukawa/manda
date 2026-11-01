---
mode: mvp
repo: manda
plan: PLAN-0029-rota-de-falhas-e-disjuntor
tier: free
goal: "Com a cota free esgotada, a lane espera com backoff de 15, 30 e 60 minutos e só volta depois de um probe ok, em vez de sair com exit 4"
done_when: "bun test tests/free_retry.test.ts"
tests_frozen: [tests/free_retry.test.ts]
touch: [src/free_retry.ts, tests/free_retry.test.ts]
pinga_task: T173
---

## Context

PLAN-0029 TASK-06. `freeRetryWait(n)` → 15, 30, 60, 60... min. Laço: espera, `probe` do 1º free; ok → devolve o modelo; falha → próxima espera. Sinal de parada injetado.
