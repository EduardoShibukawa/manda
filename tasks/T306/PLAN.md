---
mode: mvp
repo: manda
plan: PLAN-0029-rota-de-falhas-e-disjuntor
tier: free
goal: "manda breaker status lista o disjuntor de cada modelo e manda breaker reset <modelo> fecha um, para recuperação manual"
done_when: "bun test tests/breaker_cli.test.ts"
tests_frozen: [tests/breaker_cli.test.ts]
touch: [src/breaker_cli.ts, src/cli.ts, tests/breaker_cli.test.ts]
pinga_task: T306
---
