---
mode: mvp
goal: "Gate não aprova com tests_frozen criado do zero e lê [commands].verify do repo, não da worktree"
touch:
  - src/gate.ts
  - tests/gate_fix.test.ts
tests_frozen: ["tests/gate_fix.test.ts"]
done_when: "bun test tests/gate_fix.test.ts tests/worktree_gate.test.ts"
---
# T8: fix do judge (PLAN-0007 TASK-09-fix-gate)

Materializada de `.ginga/plans/PLAN-0007-manda-nucleo/TASK-09-fix-gate.md`. Achado do Verifier Judge, severidade simples.
