---
mode: padrao
goal: "manda plan show <PLAN> --json lê PLAN.md e TASK-*.md e devolve as TASKs em ordem topológica"
done_when: "bun test tests/bundle.test.ts"
tests_frozen: ["tests/bundle.test.ts", "tests/fixtures/plan-basic/PLAN.md", "tests/fixtures/plan-basic/TASK-01-a.md", "tests/fixtures/plan-basic/TASK-02-b.md", "tests/fixtures/plan-basic/TASK-03-c.md"]
touch: ["src/bundle.ts", "src/project.ts", "src/cli.ts", "tests/bundle.test.ts", "tests/fixtures/plan-basic/"]
---

## Context

- Materializada de `plans/PLAN-0007-manda-nucleo/TASK-02-leitor-bundle.md` (passada RED do Planner).
- Repo-alvo: manda. tests_frozen escritos pelo Planner; o Executor não os toca.
