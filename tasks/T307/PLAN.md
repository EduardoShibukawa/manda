---
mode: padrao
repo: manda
plan: PLAN-0029-rota-de-falhas-e-disjuntor
tier: medium
goal: "manda run observa a tentativa a cada 30 s, espera se devagar ou na fila, e se travada ou recusada mata, abre o disjuntor e segue com o próximo modelo da escada"
done_when: "bun test tests/attempt_watch.test.ts"
tests_frozen: [tests/attempt_watch.test.ts]
touch: [src/run.ts, src/attempt_watch.ts, tests/attempt_watch.test.ts]
pinga_task: T307
---
