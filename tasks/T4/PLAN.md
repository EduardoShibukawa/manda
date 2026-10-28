---
mode: padrao
goal: "Adapters claude, codex e agy no runtime port; codex recusado como executor"
done_when: "bun test tests/runtime_claude_codex_agy.test.ts"
tests_frozen: ["tests/runtime_claude_codex_agy.test.ts", "tests/fixtures/runtime/claude-ok.json", "tests/fixtures/runtime/claude-error.json", "tests/fixtures/runtime/codex-ok.jsonl", "tests/fixtures/runtime/codex-turn-failed.jsonl", "tests/fixtures/runtime/agy-success.json", "tests/fixtures/runtime/agy-invalid-model.json"]
touch: ["src/runtime/claude.ts", "src/runtime/codex.ts", "src/runtime/agy.ts", "src/runtime/index.ts", "tests/runtime_claude_codex_agy.test.ts", "tests/fixtures/runtime/"]
---

## Context

- Materializada de `plans/PLAN-0007-manda-nucleo/TASK-04-runtime-claude-codex-agy.md` (passada RED do Planner).
- Repo-alvo: manda. tests_frozen escritos pelo Planner; o Executor não os toca.
