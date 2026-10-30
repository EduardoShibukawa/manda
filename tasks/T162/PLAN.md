---
mode: padrao
goal: "decideToolCall permite ou bloqueia edit/write conforme touch e tests_frozen, e recusa os padroes de bash de risco, com motivo legivel"
done_when: "bun test tests/scope_guard.test.ts"
touch:
  - src/runtime/scope_guard.ts
  - tests/scope_guard.test.ts
  - tasks/T162/PLAN.md
tests_frozen: [tests/scope_guard.test.ts]
---
