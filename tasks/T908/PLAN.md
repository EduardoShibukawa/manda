---
mode: padrao
goal: "o gate da TASK lê [commands].verify também da raiz do workspace (bundle), e uma worktree velha da TASK não trava a próxima tentativa"
touch:
  - src/gate.ts
  - src/run.ts
  - tests/run_workspace_root.test.ts
  - tasks/T908/PLAN.md
tests_frozen: ["tests/run_workspace_root.test.ts"]
done_when: "bun test tests/run_workspace_root.test.ts tests/run.test.ts tests/run_plan_branch.test.ts tests/worktree_gate.test.ts"
---
# T908: manda run no workspace real (raiz com .ginga, repos dentro)

- O `project.toml` fica na raiz do workspace; o gate só olhava o do repo da TASK.
  Sem achar `[commands].verify`, caía no `done_when`: a TASK passava sem receipt
  e a fila do pinga nunca a via como `done`.
- Tentativa que falha deixava `.worktrees/wt-<task>`; a seguinte morria com
  "Worktree já existe". Worktree de TASK é efêmera: a velha é removida.
