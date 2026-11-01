---
mode: padrao
repo: manda
plan: PLAN-0029-rota-de-falhas-e-disjuntor
tier: medium
goal: "corrige o achado do judge: src/run.ts chama watchAttempt durante a tentativa viva (amostra /proc/<pid> + worktree + probe, mata travado pelo pid) e o laco de attemptSpecs consulta breakerOf, pulando modelo com disjuntor aberto"
done_when: "bun test tests/attempt_watch_live.test.ts tests/attempt_watch.test.ts tests/attempt_watch_run.test.ts"
tests_frozen: [tests/attempt_watch_live.test.ts]
touch: [src/run.ts, src/attempt_watch.ts, src/runtime/port.ts, src/runtime/claude.ts, src/runtime/codex.ts, src/runtime/opencode.ts, src/runtime/pi.ts, src/proc_sample.ts, tests/attempt_watch_live.test.ts]
pinga_task: T309
---
