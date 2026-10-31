---
mode: padrao
goal: "a extensao pi_scope_guard registra o handler tool_call, bloqueia com {block, reason} quando decideToolCall nega e libera com evento quando o proprio handler falha"
done_when: "bun test tests/pi_scope_guard.test.ts"
touch:
  - src/runtime/pi_scope_guard.ts
  - tests/pi_scope_guard.test.ts
  - tasks/T164/PLAN.md
tests_frozen: [tests/pi_scope_guard.test.ts]
---
