---
mode: padrao
goal: "num monorepo o repo: da TASK nomeia um pacote: manda red, run e judge usam uma worktree só do repositório e trabalham na pasta do pacote; o gate da TASK só olha arquivos do pacote"
done_when: "bun test tests/pacote_monorepo.test.ts tests/red_repo_unico.test.ts tests/red_real_pinga.test.ts tests/run_plan_branch.test.ts tests/gate.test.ts"
touch:
  - src/red.ts
  - src/run.ts
  - src/gate.ts
  - src/judge.ts
  - src/bundle.ts
  - src/cli.ts
  - tests/pacote_monorepo.test.ts
  - tasks/T916/PLAN.md
tests_frozen:
  - tests/pacote_monorepo.test.ts
---

## Contexto (PLAN-0003, AC-5)
- Hoje cada `repo:` vira uma worktree `<repo>-plan-NNNN`. Num monorepo os pacotes são pastas do mesmo repositório: duas TASKs de pacotes diferentes disputariam a mesma branch.
- Pacote = `repo:` aponta para uma pasta que está dentro de um repositório git maior.
- `manda red`: uma worktree `.worktrees/plan-NNNN` na raiz do repositório; contrato, teste congelado e commit RED ficam em `<pacote>/`; o `pinga prove-red` recebe `--root <pacote>`.
- `manda run`: a worktree da TASK é do repositório; executor e gate trabalham em `<worktree>/<pacote>`.
- Gate da TASK: status e diff relativos ao pacote, senão `tests_frozen` deixaria de casar e o guard de teste congelado passaria batido.
- `manda judge` e `manda merge <PLAN>`: um alvo por repositório git (um veredito, um merge), não um por pacote.
- Fora de monorepo nada muda.
