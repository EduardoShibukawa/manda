---
mode: padrao
repo: manda
plan: PLAN-0029-rota-de-falhas-e-disjuntor
tier: medium
goal: "manda run integra a vigia da tentativa: observa o processo vivo, mata travado pelo pid, registra a recusa no disjuntor compartilhado e troca de modelo"
done_when: "bun test tests/attempt_watch_run.test.ts"
tests_frozen: [tests/attempt_watch_run.test.ts]
touch: [src/run.ts, src/attempt_watch.ts, src/run_state.ts, tests/attempt_watch_run.test.ts]
pinga_task: T308
---
