# Fixtures de saída dos runtimes

Origem de cada arquivo (pi-harness = cópia de `pi-harness/tests/fixtures/`):

| Arquivo | Origem |
|---|---|
| `pi-ok.jsonl`, `pi-free-tier-403.jsonl`, `pi-endpoint-402.jsonl` | **real**: `pi --mode json`, capturado no SPEC 0035 (`0035/probe/`) |
| `pi-quota-429.jsonl` | derivado de `pi-free-tier-403.jsonl`: só o `errorMessage` trocado por um 429 |
| `agy-success.json`, `agy-invalid-model.json` | **real**: `agy --print`, SPEC 0037 |
| `codex-ok.jsonl`, `codex-turn-failed.jsonl` | fixtures do pi-harness (`codex/`), escritas à mão no formato do `codex exec --json` |
| `opencode-ok.jsonl`, `opencode-error-429.jsonl` | **sintético**: montado a partir dos eventos que `parseOpenCodeOutput` lê (não há captura real no workspace) |
| `claude-ok.json`, `claude-error.json` | **sintético**: campos de `parseClaudeOutput` (`claude -p --output-format json`) |

`real/` tem capturas reais de `opencode run --format json` (glm-5.3-flash-free), `claude -p`, e `codex exec`, com prompt "responda ok". A do opencode traz só `step_start` e `text`, **sem `step_finish`**: o parser não pode depender dele para tokens e custo (ficam `null`). `real/opencode-ok.jsonl` é usada em `runtime_pi_opencode.test.ts`.

Pendente: trocar os sintéticos por capturas reais (um `opencode run --format json` e um `claude -p --output-format json` de prompt trivial) antes do PLAN fechar.
