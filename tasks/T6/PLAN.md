---
mode: padrao
goal: "manda run <PLAN> [--task T] executa as TASKs em ordem: worktree, runtime, gate, merge, emitindo attempt e transition"
done_when: "bun test tests/run.test.ts"
tests_frozen: ["tests/run.test.ts"]
touch: ["src/run.ts", "src/events.ts", "src/cli.ts", "tests/run.test.ts"]
---

## Context

- Materializada de `plans/PLAN-0007-manda-nucleo/TASK-06-manda-run.md` (passada RED do Planner).
- Repo-alvo: manda. tests_frozen escritos pelo Planner; o Executor não os toca.
