---
mode: mvp
goal: "Um PLAN com duas TASKs roda fora do Pi, cada uma num runtime diferente, e as duas passam no gate"
done_when: "bun test tests/e2e/two_runtimes.test.ts"
tests_frozen: ["tests/e2e/two_runtimes.test.ts"]
touch: ["tests/e2e/two_runtimes.test.ts", "tests/e2e/stubs/"]
---

## Context

- Materializada de `plans/PLAN-0007-manda-nucleo/TASK-07-e2e-dois-runtimes.md` (passada RED do Planner).
- Repo-alvo: manda. tests_frozen escritos pelo Planner; o Executor não os toca.
