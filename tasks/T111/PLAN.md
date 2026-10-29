---
mode: padrao
goal: "manda install cria ~/.local/bin/manda (idempotente), avisa se fora do PATH, e manda --help roda"
touch:
  - src/install.ts
  - src/cli.ts
  - tests/install.test.ts
  - tasks/T111/PLAN.md
tests_frozen: [tests/install.test.ts]
done_when: "bun test tests/install.test.ts"
---

# T111: manda install
Novo `src/install.ts` (`installLink`) + rota `install` em `run()`; `--help`/`-h` viram `help`.
Symlink para `bin/manda.ts` (chmod 755 feito no install), aviso de PATH em stderr.
