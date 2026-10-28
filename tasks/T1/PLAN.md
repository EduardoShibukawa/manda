---
mode: mvp
goal: "Criar o repo manda/ (Bun/TS) com a CLI manda (alias mandacaru) e manda version --json"
done_when: "bun test tests/cli.test.ts"
tests_frozen: ["tests/cli.test.ts"]
touch: ["package.json", "tsconfig.json", "mise.toml", "bin/manda.ts", "src/cli.ts", "README.md", "tests/cli.test.ts"]
---

## Context

- Materializada de `plans/PLAN-0007-manda-nucleo/TASK-01-manda-repo.md` (passada RED do Planner).
- Repo-alvo: manda. tests_frozen escritos pelo Planner; o Executor não os toca.
