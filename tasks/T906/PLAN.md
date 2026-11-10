---
mode: padrao
goal: "o judge cego grava o veredito por repo no formato que o manda merge lê; o merge recusa veredito fail; manda red e manda merge aceitam só o PLAN e cobrem todos os repos dele"
touch:
  - src/judge.ts
  - src/merge.ts
  - src/bundle.ts
  - src/cli.ts
  - tests/conductor_plan.test.ts
  - tasks/T906/PLAN.md
tests_frozen: ["tests/conductor_plan.test.ts"]
done_when: "bun test tests/conductor_plan.test.ts tests/judge_blind.test.ts tests/judge_module.test.ts tests/judge_pick.test.ts tests/merge_gate.test.ts tests/merge_gate_plugavel.test.ts tests/red_cli.test.ts tests/red_cli_repo.test.ts tests/cli.test.ts"
---
# T906: judge cego e merge falando a mesma língua (condutor único)

- `manda judge <PLAN>`: com worktree de `plan/NNNN` nos repos do PLAN, o diff do
  bundle é `main...HEAD` de cada repo e sai um `judge/<repo>.json` com `head`.
- Um veredito por HEAD: mesmo HEAD reaproveita, sem chamar o juiz.
- `judge_seal = "none"` desliga o selo. `manda merge` com veredito `fail` sai 11.
- `manda merge <PLAN> [--root]` e `manda red <PLAN> [--root]` percorrem os repos
  do PLAN (campo `repo` das TASKs).
