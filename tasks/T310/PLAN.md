---
mode: padrao
repo: manda
plan: PLAN-0029-rota-de-falhas-e-disjuntor
tier: medium
goal: "corrige o achado grave do judge (gate 23:20) no TASK-12: sampler roda o probe (na_fila alcancavel), watchAttempt nao mata com probe ok, stop pos-kill nao aborta o waitForFree (onTakeOver), e stream_bytes medem o log da propria tentativa (logPath), nao o $GINGA_EVENTS"
done_when: "bun test tests/attempt_watch_real.test.ts tests/attempt_watch.test.ts tests/attempt_watch_live.test.ts tests/attempt_watch_run.test.ts tests/run_state.test.ts"
tests_frozen: [tests/attempt_watch_real.test.ts]
touch: [src/run_state.ts, src/proc_sample.ts, src/attempt_watch.ts, src/run.ts, src/runtime/port.ts, src/runtime/opencode.ts, src/runtime/pi.ts, src/runtime/claude.ts, src/runtime/codex.ts, tests/attempt_watch_real.test.ts]
pinga_task: T310
---
