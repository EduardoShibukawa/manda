---
mode: padrao
goal: "manda merge com exit 0 remove a worktree da branch (WIP arquivado antes) e roda git branch -d"
touch:
  - src/merge.ts
  - tests/merge_cleanup.test.ts
  - tasks/T112/PLAN.md
tests_frozen: [tests/merge_cleanup.test.ts]
done_when: "bun test tests/merge_cleanup.test.ts tests/merge_gate.test.ts tests/merge_followup.test.ts tests/merge_revert_hook.test.ts tests/merge_empty_pass.test.ts"
---

# T112: limpeza pós-merge
Só depois de exit 0: WIP sem commit da worktree vai para `<plan>/wip/` (patch), `git worktree remove`, `git branch -d`.
Falha na limpeza avisa em stderr e não muda o exit 0.
