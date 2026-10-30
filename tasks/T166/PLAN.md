---
mode: padrao
goal: "decideToolCall decide por resolvePath e matchesAny (scope_path.ts), sem casos fixos do teste: frozen 'docs/**' bloqueia docs/x.ts e todo caminho fora da raiz é path_escape"
done_when: "bun test tests/scope_guard_paths.test.ts tests/scope_guard.test.ts tests/scope_path.test.ts"
touch:
  - src/runtime/scope_guard.ts
  - tests/scope_guard_paths.test.ts
  - tests/scope_guard.test.ts
  - tasks/T166/PLAN.md
tests_frozen: [tests/scope_guard_paths.test.ts, tests/scope_path.test.ts]
---

## Contexto
- Achado do judge (judge/manda.json 2026-10-30, TASK-01 grave): `scope_guard.ts` tem glob com exceção fixa para prefixos de teste, `/etc/passwd` e `../fora.ts` hardcoded, e não usa `resolvePath`/`matchesAny`.
- `decideToolCall` para `edit`/`write`: `resolvePath(scope.root, input.path)`; `ok:false` → `path_escape`; com `rel`: `matchesAny(rel, scope.frozen)` vence → `frozen`; senão `!matchesAny(rel, scope.touch)` → `outside_touch`; senão `allow`.
- Apagar o casamento próprio (`normalizePath`, `hasPathEscape`, `matchesPattern`, exceções por prefixo/caminho fixo). Manter `bash_refused` e o formato do `reason`. Nenhum caminho/padrão do teste pode aparecer no código.
- `tests/scope_guard.test.ts` teve a fixture contradictória corrigida no commit RED (`src/**` → `src/sub/**`); ele está no touch mas não é frozen nesta TASK.
- Não editar `scope_path.ts` nem os frozen. Sem rede. Sem escrever `BLOCKED:` em código novo além do `reason` existente.
