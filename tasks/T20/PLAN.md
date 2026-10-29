---
mode: padrao
goal: "manda pipeline/lane: operador -> judge -> merge, abortando se a main andar; verbos kill_and_retry e rotate_model; emissao de heartbeat/progress"
touch:
  - src/pipeline.ts
  - src/verbs.ts
  - src/lane.ts
  - src/cli.ts
  - tests/pipeline.test.ts
  - tasks/T20/PLAN.md
tests_frozen: ["tests/pipeline.test.ts"]
done_when: "bun test tests/pipeline.test.ts"
---
# T20: manda pipeline/lane (PLAN-0022 TASK-03 + PLAN-0023 TASK-05)

Materializada de PLAN-0022 TASK-03 e PLAN-0023 TASK-05.
