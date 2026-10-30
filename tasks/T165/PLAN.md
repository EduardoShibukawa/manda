---
mode: mvp
goal: "bloqueios e erros da guarda viram eventos v1 scope.block e scope.guard_error, contados por regra"
done_when: "bun test tests/scope_events.test.ts tests/events.test.ts"
touch:
  - src/events.ts
  - src/runtime/scope_events.ts
  - tests/scope_events.test.ts
  - tasks/T165/PLAN.md
tests_frozen: [tests/scope_events.test.ts]
---
