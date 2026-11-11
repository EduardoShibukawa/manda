---
mode: padrao
goal: "o fluxo da branch do PLAN funciona num workspace de repo único (o .ginga dentro do próprio repo, TASKs sem repo:): o manda red materializa essas TASKs e o manda merge não trata o bundle como mudança pendente do código"
done_when: "bun test tests/red_repo_unico.test.ts tests/merge_bundle_no_trunk.test.ts tests/red_real_pinga.test.ts tests/merge_gate.test.ts"
touch:
  - src/red.ts
  - src/merge.ts
  - tests/red_repo_unico.test.ts
  - tests/merge_bundle_no_trunk.test.ts
  - tasks/T914/PLAN.md
tests_frozen:
  - tests/red_repo_unico.test.ts
  - tests/merge_bundle_no_trunk.test.ts
---

## Contexto
- Achado pelo gate ao mergear o g-inga: o e2e do onboarding (um repo, `ginga init`, PLAN sem `repo:` nas TASKs) não fechava no fluxo novo.
- `manda red` filtrava as TASKs por `repo === <nome>`; TASK sem `repo:` nunca casava e nada era materializado.
- No repo único a worktree do PLAN nascia solta dentro do próprio repo; passa a ficar em `.worktrees/plan-NNNN`.
- O teste congelado pode ficar em `frozen/` direto, sem repetir o nome da pasta do repo.
- `manda merge` recusava com "main com mudanças não commitadas" porque o red anota `pinga_task` na TASK do bundle, que neste caso é arquivo do próprio repo. O `.ginga/` é estado do condutor e sai dessa conferência.
- Com `repo:` nas TASKs nada muda.
