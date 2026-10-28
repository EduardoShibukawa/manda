# manda

Manda-CARU: *Coordination of Agent Runtime Units* — o orquestrador do ecossistema -Ingá. Ele despacha TASKs de um PLAN para runtimes de agentes (Pi, Claude, Codex, OpenCode, AGY) e fecha cada TASK com um receipt verificado.

## CLI

```
manda version          # manda 0.1.0
manda version --json   # {"schema_version":1,"name":"manda","version":"0.1.0"}
manda <outro>          # exit 2 (comando desconhecido)
```

Alias: `mandacaru`.

## Name origin

**Manda-CARU** = **Mandacaru** · Coordination of Agent Runtime Units ([DECISION-0001](../.ginga/knowledge/decisions/DECISION-0001-nomes.md)).

- **"Manda"** é literalmente o que ele faz: `manda run PLAN-0005` se lê como "manda rodar o PLAN".
- **O mandacaru aguenta a seca:** o cacto do sertão que sobrevive com quase nada, como um orquestrador feito para render com quota escassa e modelos baratos.
- **É forró de raiz:** "Mandacaru quando fulora na seca é o sinal que a chuva chega no sertão." A flor é o sinal de que vem coisa boa — como o receipt que fecha o PLAN.

## Test

```
bun test tests/cli.test.ts
```
