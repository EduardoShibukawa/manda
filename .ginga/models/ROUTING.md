---
type: policy
title: Roteamento de modelos e budget
ladder:
  - {tier: free, tries: 2}
  - {tier: medium, tries: 2}
  - {tier: strong, tries: 1}
breaker: {same_reason: 3, ignore: [quota_exhausted, infra]}
pools:
  executor:
    free: [opencode/glm-5.3-flash-free, opencode/deepseek-v4.1-flash-free, opencode-go/qwen3.8-flash, opencode-go/deepseek-v4.1-flash]
    medium: [opencode-go/qwen3.8-flash, opencode-go/deepseek-v4.1-flash]
    strong: [opencode-go/deepseek-v4-pro]
  operador: [opencode-go/deepseek-v4.1-flash]
  planner: [claude-opus-5-5, opencode-go/deepseek-v4-pro]
  judge: [agy/gemini-3.8-flash, codex/gpt-6-luna]
budget: {month_usd: 10, task_usd: 0.25, plan_usd: 1.5, warn_pct: 80, ask_owner: [over_cap, runtime_claude]}
---
## Princípios

1. **Use o mais barato que passa.** A TASK declara `tier`, e a escolha começa no mais barato daquele tier.
2. **Assinatura antes de crédito.** Gaste free, depois assinatura, e só por último crédito pago.
3. **O Judge é de outra família.** O Verifier Judge nunca é da família do Executor nem da do Planner (`pinga judge` já aplica `assertDistinctFamily`).
4. **A quota é estado, não arquivo.** Os `PROVIDER-*.md` dizem *como* consultar; o valor atual vem do comando. Hoje a consulta é manual ou parcial, e isso é um gap do ginga.

## Preferência por papel

| Papel | 1ª | 2ª | 3ª |
|---|---|---|---|
| Spec Researcher | claude (Pro) | codex | opencode-go `kimi-k3.1-pro` |
| Planner | claude (Pro) | opencode-go `qwen3.8-max` | codex |
| Spec Judge | agy (Gemini) | codex | opencode-go de outra família |
| Executor `free` | zen `-free` | opencode-go cheap | local-llama |
| Executor `medium` | opencode-go medium+ | zen `-free` maiores | zen pago |
| Executor `strong` | opencode-go top (`kimi-k3.1-pro`, `qwen3.8-max`, `deepseek-v4-pro`) | zen pago (`deepseek-v4-pro`) | claude (último, para preservar o Pro) |
| Verifier Judge | agy (Gemini) | codex | opencode-go `claude-haiku-5-5`/`gpt-6-luna`, desde que de família diferente do executor |

## Escalada

- Cada TASK tem até **5 tentativas**: `free` ×2 → `medium` ×2 → `strong` ×1. Falhar duas vezes num tier sobe um tier automaticamente, sem pedir OK.
- O breaker (Lei 3 do pinga) dispara com **3 falhas seguidas pelo mesmo motivo** (o mesmo `reason_code`). Falhas por `quota_exhausted` e `infra` não contam para ele.
- O **OK do dono só é pedido** quando a próxima opção passa do teto de budget (TASK, PLAN ou mês) ou quando o `strong` cairia no claude.
- Esgotou: `blocked` + notificação, e o Planner reavalia a TASK (reescrever, quebrar ou virar investigação).

**Codex não é executor por enquanto.** O runner do pi-harness recusa o Codex como worker (`runners.ts:89`, gate `PI_CODEX_ENABLED`) e a assinatura Go é melhor gasta como judge.

## Budget do Zen

Proposta inicial; ajustar ao saldo de créditos.

| Limite | Valor | Ao atingir |
|---|---|---|
| Mensal | US$ 10 | 80%: aviso no Discord; 100%: Zen pago desligado até o mês virar |
| Por TASK | US$ 0,25 | Para a TASK e escala ou bloqueia |
| Por PLAN | US$ 1,50 | Pausa o PLAN e pede OK ao dono |

O Zen pago só entra quando: (a) o OpenCode Go está sem quota e os `-free` falharam, ou (b) é preciso diversidade de família para o judge e agy e codex estão esgotados.

## Legado

Só o `.pi/router.json` da raiz usa modelos antigos (`claude-3-7-sonnet`, `gemini-2.5-flash`). O `pi-harness/.pi/router.json` está atualizado (pools com glm/qwen/kimi/deepseek; codex marcado como não worker) e é a base dos pools do manda. Esta política substitui os dois quando o orquestrador existir.

## Vigente desde 2026-10-27 20:20 (decisão do dono)

Enquanto valer, esta seção vence as tabelas acima:

- **OpenCode Go fora**, em qualquer tier. Não é só falta de quota: é decisão.
- **Executor:** só OpenCode Zen.
  - Escada free: `glm-5.3-flash-free` → `deepseek-v4.1-flash-free` → `nemotron-3-ultra-free`.
  - Quando o free não fecha: `opencode/deepseek-v4-pro` (pago).
- **Teto do Zen pago:** US$ 0,50 por TASK e US$ 2,00 no total da rodada. O teto é **checado antes** de cada tentativa paga, porque o teto antigo de 0,25 estourou ao ser medido só depois da chamada.

## Vigente desde 2026-10-28 (decisão do dono; substitui a seção anterior onde conflitar)

- **OpenCode Go liberado só dentro do `opencode run`** (onde a assinatura cobre). Fora dele, o Go continua **proibido**: no Pi, no adapter `pi` do manda e em qualquer outro runtime.
- Os modelos **free do Zen** (`*-free`) só funcionam dentro do opencode. Pelo Pi, dão 429 `FreeUsageLimitError`.
- O **Pi** só usa Zen pago barato, nunca Go nem free.
- **Nunca** escalar automaticamente para modelo forte: o pro só entra com `tier: strong` explícito.

| Papel | Onde roda | Modelo (em ordem) |
|---|---|---|
| Executor | `opencode run --standalone` | `opencode/glm-5.3-flash-free` → `opencode/deepseek-v4.1-flash-free` → `opencode-go/qwen3.8-flash` → `opencode-go/deepseek-v4.1-flash`; com `tier: strong`: `opencode-go/deepseek-v4-pro` |
| Operador | script / `manda run`; o LLM só no resíduo | `opencode run` com `opencode-go/deepseek-v4.1-flash` |
| Planner (RED) e pesquisa | Claude Code pela **assinatura**, uma sessão curta por TASK | `claude-opus-5-5`; se a quota acabar: `opencode run` com `opencode-go/deepseek-v4-pro` |
| Judge | outra família | Codex `gpt-6-luna` + Gemini `gemini-3.8-flash` (agy) |
| Pi (quando for usado) | Pi | `opencode/qwen3.8-flash` ou `opencode/deepseek-v4.1-flash` (Zen pago) |

- **Teto:** um teto **por rodada somando tudo** (Pi + executores + pesquisa) no `paid-spend.tsv`; o Go dentro do opencode não conta.
- **Referência de custo** (sessão real de 64 turnos): deepseek-v4-pro US$1,97; deepseek-v4.1-flash ~US$0,31; qwen3.8-flash ~US$0,20; opus-5.5 pelo Zen ≥ US$5.

### Limites do OpenCode Go (fonte: https://opencode.ai/docs/go/, lida em 2026-10-28)

- **O limite é por modelo, não um pool.** Cada modelo tem um teto mensal em US$, com janelas de 5 h (20%), semana (50%) e mês (100%). Uma escada com vários modelos soma os limites.
- **Extra Usage**, se estiver ligado no Console, cobra do saldo pay-as-you-go quando o limite acaba. **Deve ficar desligado** para o teto valer.
- No plano Go (US$10/mês):
  - `deepseek-v4.1-flash`: US$80 (~US$16 a cada 5 h);
  - `glm-5.3-flash`: US$60;
  - `qwen3.8-flash`: US$30;
  - `deepseek-v4-pro`, `gpt-6-luna` e `claude-haiku-5-5`: US$15 cada (~US$3 a cada 5 h). São escassos.
- **Ilimitados (por tempo limitado):**
  - `beam-free`: contexto de 1M, raciocínio, **sem treino**, retenção de 30 dias;
  - `iceman-contributor-free`: contexto de 262 mil, raciocínio, **contributor**: prompts e respostas **usados para treino**, sem ZDR. Use só em TASK de código de repos MIT, **nunca** com handoff, operador, pesquisa ou dados do dono.
- **Free do Zen** (https://opencode.ai/docs/zen/): "Free-tier chat models require OpenCode". A doc não diz se o limite é por modelo ou compartilhado.
- **A qualidade dos dois ilimitados ainda não foi medida:** é o PLAN-0019.

### Classificação estruturada: Jev (fonte: https://opencode.ai/docs/zen/, 2026-10-28)

- **Jev 1.13 / Jev 1.13 Free** (TypeSafe AI, "System One"): **não gera texto**. Avalia um `state` contra perguntas tipadas (`noul` sim/não, `choice`, `score`) e devolve valor + probabilidade, com várias perguntas em paralelo.
- Endpoint `https://opencode.ai/inference/systemone/v1/systemone` (Bearer da API key do Console). O Free é grátis por tempo limitado; o pago custa US$0,042 por 1M de entrada, com saída grátis.
- **Papel candidato:** classificador (motivo de `BLOCKED:`, novo × regressão no judge, triagem de tier, severidade de alerta). Avaliação em `knowledge/research/determinismo-e-placement.md`. **Não adotado** até o experimento de acurácia (≥ 90% contra rótulos dos `log.md`).
