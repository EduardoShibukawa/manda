---
mode: padrao
goal: "o juiz cego funciona com o agy real em modo sem tela: o pedido manda ler os arquivos com a ferramenta de leitura (sem comando de shell), e resposta vazia com ação negada vira falha do runtime em vez de passar como sucesso"
done_when: "bun test tests/judge_headless.test.ts tests/judge_blind.test.ts tests/runtime_claude_codex_agy.test.ts"
touch:
  - src/judge.ts
  - src/runtime/agy.ts
  - tests/judge_headless.test.ts
  - tasks/T913/PLAN.md
tests_frozen:
  - tests/judge_headless.test.ts
---

## Contexto
- Primeiro juiz de verdade neste Mac (agy 1.5.4, `--print --mode plan`): o modelo tentou `cat` para ler o material, o modo sem tela negou o comando e a resposta veio vazia com `status: SUCCESS` e `denied_actions`.
- O manda tratou como sucesso sem veredito e saiu com 1, sem dizer por quê.
- Com o pedido dizendo para usar a ferramenta de leitura de arquivo, o mesmo agy lê e responde.
- O pedido continua cego: só nomeia os arquivos do diretório do juiz.
