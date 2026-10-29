---
mode: padrao
goal: "O provider rg + git atende outline, slice e impact com o mesmo schema e os mesmos caminhos do gira no fixture"
done_when: "bun test tests/context_rg.test.ts tests/context_port.test.ts"
touch:
  - src/context/rg.ts
  - src/context/port.ts
  - tests/context_rg.test.ts
  - tests/fixtures/context/
  - tasks/T151/PLAN.md
tests_frozen: [tests/context_rg.test.ts]
---

## Contexto
- `tests/fixtures/context/root-rg` (provider rg no project.toml) tem a mesma árvore de `root-gira`;
  `tests/fixtures/context/gira-out/slice.json` é a saída gravada do gira real v0.3.0 usada no fake.
- `src/context/rg.ts`: `rgContext(cap, arg, cwd)` — outline: `rg -n` com regex de definição por
  extensão (ts/js: function|class|interface|enum|const-arrow; go: func|type; java: class|interface;
  py: def|class); item {path relativo ao cwd, line, symbol, kind, text=linha da def}.
- slice <símbolo>: def via rg -n + ~8 linhas seguintes (Bun.spawnSync `rg -n -A8`), texto juntado.
- impact <path|símbolo>: `git grep -l <arg>` (refs) + `git log --name-only` p/ co-change do arg;
  fora de repo git ou spawn falho → unsupportedResult("rg", cap). Extra `gira:*` no rg → unsupported.
- `src/context/port.ts`: trocar o stub `provider === "rg"` por `rgContext(...)`. Nada além de rg/git.
