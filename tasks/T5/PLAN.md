---
mode: padrao
goal: "Worktree por TASK, gate verify_cmd genérico e proteção de tests_frozen antes do gate"
done_when: "bun test tests/worktree_gate.test.ts"
tests_frozen: ["tests/worktree_gate.test.ts"]
touch: ["src/worktree.ts", "src/gate.ts", "tests/worktree_gate.test.ts"]
---

## Context

- Materializada de `plans/PLAN-0007-manda-nucleo/TASK-05-worktree-gate.md` (passada RED do Planner).
- Repo-alvo: manda. tests_frozen escritos pelo Planner; o Executor não os toca.
