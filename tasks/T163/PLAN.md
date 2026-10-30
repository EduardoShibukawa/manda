---
mode: padrao
goal: "resolvePath e matchesAny normalizam caminhos, bloqueiam escape por .. e symlink e aceitam prefixo de diretorio e globs"
done_when: "bun test tests/scope_path.test.ts"
touch:
  - src/runtime/scope_path.ts
  - src/runtime/scope_ignore.json
  - tests/scope_path.test.ts
  - tasks/T163/PLAN.md
tests_frozen: [tests/scope_path.test.ts]
---
