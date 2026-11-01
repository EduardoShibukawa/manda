---
mode: padrao
repo: manda
plan: PLAN-0033-guard-de-segredos
tier: medium
goal: "o manda run deriva GINGA_GUARD_LANE=<PLAN>/<TASK> (herdando a do processo quando a lane já exportou) e preenche request.env, mantendo o guard ligado com falha fechada no run real"
done_when: "bun test tests/run_guard_lane.test.ts && bun test"
tests_frozen: [tests/run_guard_lane.test.ts]
touch: [src/run.ts, src/runtime/env.ts, tests/run_guard_lane.test.ts]
pinga_task: T320
---
## Contexto
- PLAN-0033 TASK-09 (achado grave do judge no TASK-07): run.ts não definia request.env, então guardOn() era false no run real.
- Em `src/run.ts` (construção do RunRequest): `request.env = runtimeEnv({ ...process.env, G: ctx.root, GINGA_GUARD_LANE: process.env.GINGA_GUARD_LANE ?? `${ctx.plan}/${shortTaskId(task.task)}`.toLowerCase() })`.
- Falha fechada: guard ligado + GUARD_DIR sem contrib/guard/pi.ts → o adapter pi/opencode devolve `guard_missing` sem spawn (já existe; o teste RED do run prova de ponta a ponta).
- Não toque nos congelados de TASKs anteriores (tests/runtime_guard.test.ts, tests/runtime_env.test.ts).
