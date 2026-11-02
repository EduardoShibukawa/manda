---
mode: padrao
repo: manda
plan: PLAN-0033-guard-de-segredos
tier: medium
goal: "os runtimes pi e opencode do manda exportam GINGA_GUARD_LANE e passam a extensão (-e) ou OPENCODE_CONFIG_DIR; guard ausente com guard ligado vira guard_missing sem spawn"
done_when: "bun test tests/runtime_guard.test.ts && bun test"
tests_frozen: [tests/runtime_guard.test.ts]
touch: [src/runtime/env.ts, src/runtime/pi.ts, src/runtime/opencode.ts, tests/runtime_guard.test.ts]
pinga_task: T319
---
## Contexto
- PLAN-0033 TASK-07. Guard ligado = GINGA_GUARD_LANE no env e GINGA_GUARD != "off" (padrão "enforce"). GUARD_DIR vem do env do request (padrão: checkout da main do ginga, irmão do repo manda).
- `env.ts`: com guard ligado, `runtimeEnv` carimba GINGA_GUARD e GINGA_GUARD_LOG (preserva os do base); sem lane, não adiciona nada (runtime_env.test.ts congela env vazio = 1 chave).
- `pi.ts`: argv ganha `-e <GUARD_DIR>/contrib/guard/pi.ts` (coexiste com o `-e` do PLAN-0034). `opencode.ts`: env ganha OPENCODE_CONFIG_DIR=<GUARD_DIR>/contrib/guard/opencode-config.
- Guard ausente (falta contrib/guard/pi.ts|opencode.ts) com guard ligado → RunResult `failure: "guard_missing"` sem chamar o spawn. NÃO adicione "guard_missing" ao array FAILURES de port.ts (tests/runtime_pi_opencode.test.ts congela a lista); cast no tipo basta.
