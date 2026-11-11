---
mode: padrao
goal: "o manda acha o checkout do ginga (guard de segredos) por GUARD_DIR, GINGA_HOME ou pelo ginga do PATH, e não mais só pela pasta vizinha chamada ginga"
touch:
  - src/runtime/env.ts
  - tests/runtime_env_guard_dir.test.ts
  - tasks/T904/PLAN.md
tests_frozen: ["tests/runtime_env_guard_dir.test.ts"]
done_when: "bun test tests/runtime_env_guard_dir.test.ts tests/runtime_guard.test.ts tests/run_guard_lane.test.ts tests/runtime_pi_scope.test.ts tests/runtime_env.test.ts"
---
# T904: guard sem depender do nome da pasta (fase 1)

- Ordem: `GUARD_DIR` → `GINGA_HOME` → `ginga` do PATH (symlink para `<repo>/bin/ginga.ts`) → pasta vizinha `ginga` ou `g-inga` que tenha `contrib/guard`.
- Nada encontrado: devolve a vizinha `ginga`, e os adapters já falham fechado (`guard_missing`).
- O clone do GitHub se chama `g-inga`; no homelab a pasta é `ginga`.
