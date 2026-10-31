---
mode: mvp
goal: "probe chama o modelo com 'responda só: ok' e stdin fechado e diz se ele está saudável"
done_when: "bun test tests/probe.test.ts"
tests_frozen: [tests/probe.test.ts]
touch: [src/probe.ts, tasks/T168/PLAN.md]
pinga_task: T168
---

## Context

- Segunda TASK do PLAN-0029 (rota de falhas). `probeArgv` e `probe` permitem verificar se um modelo responde sem gastar uma tentativa real.
