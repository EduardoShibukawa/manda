---
mode: padrao
goal: "manda merge <PLAN> <repo> <branch> reproduz o gate de .ginga/bin/merge-gate.sh (exit 0/2/10/11/12/13/14/15)"
touch:
  - src/merge.ts
  - src/cli.ts
  - tasks/T16/PLAN.md
tests_frozen: ["tests/merge_gate.test.ts", "tests/fixtures/merge/pinga-stub"]
done_when: "bun test tests/merge_gate.test.ts"
---
# T16: manda merge (gate determinístico) — PLAN-0022 TASK-01

Materializada de `.ginga/plans/PLAN-0022-merge-gate-no-pacote/TASK-01-manda-merge.md`.
Referência executável: `.ginga/bin/merge-gate.sh` (códigos 0/2/10/11/12/13/14/15 + revert automático).
