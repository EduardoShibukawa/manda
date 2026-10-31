---
mode: mvp
goal: "Todo runtime do manda roda com PYTHONDONTWRITEBYTECODE=1 e stdin fechado"
done_when: "bun test tests/runtime_env.test.ts"
tests_frozen: [tests/runtime_env.test.ts]
touch: [src/runtime/env.ts, src/runtime/index.ts, tests/runtime_env.test.ts]
pinga_task: T170
---

## Context

PLAN-0029 TASK-05. `runtimeEnv(base)` acrescenta `PYTHONDONTWRITEBYTECODE=1`;
o spawn de todos os runtimes (`opencode`, `pi`, `claude`, `codex`, `agy`) usa
`stdin: "ignore"` (SPAWN_STDIN). Previne `scope_drift` por `__pycache__`.
