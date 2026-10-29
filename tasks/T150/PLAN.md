---
mode: padrao
goal: "manda context <cap> <arg> --json resolve o provider do project.toml e normaliza a saída do gira num schema único"
done_when: "bun test tests/context_port.test.ts"
touch:
  - src/context/port.ts
  - src/context/gira.ts
  - src/cli.ts
  - tests/context_port.test.ts
  - tasks/T150/PLAN.md
tests_frozen: [tests/context_port.test.ts]
---

## Contexto
- `tests/fixtures/context/` (a TASK congela o diretório; aqui só o .test.ts, bug do prove-red) é intocável por scope_drift.
- Protocolo (doc 02 §2): root = cwd; `[context].provider` = `gira|rg|<comando>` (ausente → gira);
  schema único `{schema_version:1, provider, capability, items:[{path,line,symbol,kind,text}]}`;
  capacidade/provedor ausente ou spawn falho → `{items:[],unsupported:true}` exit 0; sem cap ou
  sem arg em outline/slice/impact → exit 2. GUARDED_COMMANDS fica como está.
- Adapter gira: `gira outline|slice|impact <arg> --format json`; node.evidence[].locator →
  path/line(start_line), symbol=name, kind=ts_kind ou kind minúsculo, text=description;
  capabilities: `gira capabilities --json` se existir, senão ["outline","slice","impact"];
  extra `gira:tour` → `gira tour` (step.read "repo@sha:path#Lx-Ly" → path/line, namespace em
  capability); gira sem binário → aviso no stderr citando gira e rg + provider "rg" (rg: TASK-05).
- Custom (`<comando>` no PATH): spawn `<comando> <cap> [arg] --json`; passa direto.
