---
mode: padrao
goal: "manda merge num monorepo: confere os receipts por pacote (gate com a pasta do pacote e só as TASKs dele) e roda a suíte só dos pacotes tocados, cada uma na pasta do pacote"
done_when: "bun test tests/merge_monorepo.test.ts tests/merge_gate.test.ts tests/merge_gate_plugavel.test.ts tests/merge_bundle_no_trunk.test.ts"
touch:
  - src/merge.ts
  - tests/merge_monorepo.test.ts
  - tasks/T915/PLAN.md
tests_frozen:
  - tests/merge_monorepo.test.ts
---

## Contexto (PLAN-0003, AC-4)
- Hoje o merge acha as TASKs do diff por `tasks/(T\d+)/` sem saber de que pacote, chama o gate uma vez na raiz e roda `bun test` na raiz.
- Monorepo = a raiz do repositório não tem `package.json` e os arquivos alterados estão em pastas que têm.
- Gate: uma chamada por pacote, com `{worktree}` = pasta do pacote na worktree e `{tasks}` = só os contratos dele.
- Suíte: `bun test` em cada pacote tocado, na `main` e na branch; a falha carrega o nome do pacote, então o mesmo nome de teste em dois pacotes não se confunde.
- Repositório com `package.json` na raiz continua exatamente como antes.
