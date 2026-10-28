import { appendFileSync } from "node:fs";
import { randomFillSync } from "node:crypto";

/**
 * Emissor do schema de eventos v1 (`knowledge/design/ginga-revamp/07-eventos.md`).
 *
 * O contrato é um documento, não uma lib compartilhada: o manda implementa o
 * seu lado aqui. Se `$GINGA_EVENTS` existir, cada evento vira uma linha JSONL
 * (append de menos de 4 KiB, atômico entre processos); sem a variável nada é
 * escrito e o comando segue igual.
 */

export const EVENT_VERSION = 1;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48 bits de tempo + 80 bits aleatórios em Crockford base32. */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let rest = Math.floor(now);
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  const bytes = randomFillSync(new Uint8Array(16));
  let random = "";
  for (const byte of bytes) random += CROCKFORD[byte % 32];
  return time + random;
}

/** Campos opcionais do envelope: preencha os que existirem. */
export interface EventScope {
  repo?: string;
  intent?: string;
  spec?: string;
  plan?: string;
  task?: string;
}

export interface MandaEvent extends EventScope {
  v: number;
  ts: string;
  source: string;
  kind: string;
  id: string;
  data: Record<string, unknown>;
}

export interface EmitOptions {
  source?: string;
  now?: Date;
}

const SCOPE_KEYS = ["repo", "intent", "spec", "plan", "task"] as const;

/** Monta o envelope v1 (sem escrever nada). */
export function buildEvent(
  kind: string,
  data: Record<string, unknown>,
  scope: EventScope = {},
  opts: EmitOptions = {},
): MandaEvent {
  const event: MandaEvent = {
    v: EVENT_VERSION,
    ts: (opts.now ?? new Date()).toISOString(),
    source: opts.source ?? "manda",
    kind,
    id: ulid(),
    data,
  };
  for (const key of SCOPE_KEYS) {
    const value = scope[key];
    if (typeof value === "string" && value.trim()) event[key] = value.trim();
  }
  return event;
}

/**
 * Emite um evento em `$GINGA_EVENTS`; sem a variável, só devolve o evento
 * para quem quiser imprimir em stdout. Falha de escrita propaga: evento
 * perdido é bug, não motivo para esconder o erro.
 */
export function emitEvent(
  kind: string,
  data: Record<string, unknown>,
  scope: EventScope = {},
  opts: EmitOptions = {},
): MandaEvent {
  const event = buildEvent(kind, data, scope, opts);
  const target = process.env.GINGA_EVENTS;
  if (target) appendFileSync(target, `${JSON.stringify(event)}\n`);
  return event;
}
