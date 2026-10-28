---
mode: padrao
goal: "Runtime port com adapters pi e opencode portados do pi-harness, sem dependência do Pi"
done_when: "bun test tests/runtime_pi_opencode.test.ts"
tests_frozen: ["tests/runtime_pi_opencode.test.ts", "tests/fixtures/runtime/README.md", "tests/fixtures/runtime/agy-invalid-model.json", "tests/fixtures/runtime/agy-success.json", "tests/fixtures/runtime/claude-error.json", "tests/fixtures/runtime/claude-ok.json", "tests/fixtures/runtime/codex-ok.jsonl", "tests/fixtures/runtime/codex-turn-failed.jsonl", "tests/fixtures/runtime/opencode-error-429.jsonl", "tests/fixtures/runtime/opencode-ok.jsonl", "tests/fixtures/runtime/pi-endpoint-402.jsonl", "tests/fixtures/runtime/pi-free-tier-403.jsonl", "tests/fixtures/runtime/pi-ok.jsonl", "tests/fixtures/runtime/pi-quota-429.jsonl", "tests/fixtures/runtime/real/opencode-ok.jsonl"]
touch: ["src/runtime/port.ts", "src/runtime/pi.ts", "src/runtime/opencode.ts", "src/runtime/failure.ts", "tests/runtime_pi_opencode.test.ts", "tests/fixtures/runtime/"]
---

## Context

- Materializada de `plans/PLAN-0007-manda-nucleo/TASK-03-runtime-pi-opencode.md` (passada RED do Planner).
- Repo-alvo: manda. tests_frozen escritos pelo Planner; o Executor não os toca.
