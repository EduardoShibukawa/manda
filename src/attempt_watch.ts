import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

import { breakerOf, recordFailure, recordSuccess } from "./breaker";
import { emitEvent } from "./events";
import { loadEscalation } from "./escalation";
import { waitForFree } from "./free_retry";
import { pickModel } from "./ladder";
import { classifyRun, type RunObs } from "./run_state";

/** Intervalo fixo de amostragem da tentativa. */
export const ATTEMPT_POLL_MS = 30_000;

const FALLBACK_FREE_MODELS = [
  "opencode/glm-5.3-flash-free",
  "opencode/deepseek-v4.1-flash-free",
];

type EscalationWithPools = {
  pools?: Record<string, string[]>;
};

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/**
 * Modelos que podem entrar na próxima tentativa. A rota vem do ROUTING do
 * workspace (`root`); a lista final é apenas uma rota de emergência para o
 * watcher funcionar também quando o workspace ainda não tem `.ginga/models`.
 */
function freeModelsFrom(root: string, current: string): string[] {
  let routed: string[] = [];
  try {
    const escalation = loadEscalation(root) as EscalationWithPools | null;
    routed = escalation?.pools?.free ?? [];
  } catch {}

  const configured = (process.env.MANDA_FREE_MODELS ?? "")
    .split(/[\s,]+/)
    .filter(Boolean);

  return unique([...routed, ...configured, ...FALLBACK_FREE_MODELS, current]);
}

function freeModels(current: string): string[] {
  return freeModelsFrom(process.cwd(), current);
}

/** Caminho do state.db compartilhado; o ambiente vence para isolamento. */
export function stateDbPath(root: string): string {
  const configured = process.env.GINGA_STATE_DB;
  if (configured && configured !== "") return configured;
  return join(root, ".ginga", "state", "state.db");
}

/** Abre (criando se preciso) o state.db compartilhado da raiz do workspace. */
export function openStateDb(root: string): Database {
  const path = stateDbPath(root);
  mkdirSync(dirname(path), { recursive: true });
  return new Database(path);
}

/**
 * Registra a falha no disjuntor compartilhado e escolhe o próximo modelo
 * livre pela escada free da rota real da TASK (`root`). Não emite evento: o
 * `attempt` é emitido uma única vez pelo fluxo principal (`run.ts`) ou pelo
 * `watchAttempt`, evitando evento duplicado.
 */
export function planNextAfterFailure(o: {
  root: string;
  db: Database;
  model: string;
  reason: string;
  now?: Date;
}): { next: string | null; reason: string } {
  const now = o.now ?? new Date();
  recordFailure(o.db, o.model, o.reason, now);
  const free = freeModelsFrom(o.root, o.model);
  const picked = pickModel({
    tier: "free",
    pools: {},
    free,
    allowPaid: false,
    capOk: false,
    mitRepo: false,
    breaker: (model) => breakerOf(o.db, model, now).state,
  });
  return { next: picked.model, reason: picked.reason };
}

async function safeProbe(
  probe: (model: string) => Promise<{ ok: boolean }>,
  model: string,
): Promise<{ ok: boolean }> {
  try {
    return await probe(model);
  } catch {
    return { ok: false };
  }
}

/**
 * Vigia uma tentativa enquanto ela está viva. `devagar` e `na_fila` apenas
 * avançam a próxima amostragem; `ok` fecha o disjuntor. Falhas abrem o
 * disjuntor do modelo e procuram outro na escada.
 */
export async function watchAttempt(o: {
  sample: () => Promise<RunObs>;
  kill: () => void;
  probe: (m: string) => Promise<{ ok: boolean }>;
  db: Database;
  model: string;
  cfg: { patience_min: number; no_progress_min: number };
  sleep: (ms: number) => Promise<void>;
}): Promise<{ outcome: "done" | "switched" | "waiting"; next?: string }> {
  const free = freeModels(o.model);

  for (;;) {
    const observation = await o.sample();
    const classified = classifyRun(observation, o.cfg);

    if (classified.state === "ok") {
      recordSuccess(o.db, o.model);
      return { outcome: "done" };
    }

    if (classified.state === "devagar" || classified.state === "na_fila") {
      await o.sleep(ATTEMPT_POLL_MS);
      continue;
    }

    const now = new Date();
    let probeOk: boolean | undefined;

    if (classified.state === "travado") {
      probeOk = (await safeProbe(o.probe, o.model)).ok;
      try {
        o.kill();
      } catch {}
    }

    const planned = planNextAfterFailure({
      root: process.cwd(),
      db: o.db,
      model: o.model,
      reason: classified.reason,
      now,
    });
    const picked = { model: planned.next, reason: planned.reason };

    let next = picked.model;
    if (!next) {
      next = await waitForFree({
        free,
        probe: (model) => safeProbe(o.probe, model),
        sleep: o.sleep,
        stop: () => false,
      });
    }

    emitEvent("attempt", {
      runtime: o.model.includes("/") ? o.model.split("/")[0]! : o.model,
      model: o.model,
      passed: false,
      failure: classified.reason,
      ...(probeOk === undefined ? {} : { probe_ok: probeOk }),
      ...(next ? { next_model: next } : {}),
      selection_reason: picked.reason,
      via: "attempt_watch",
    });

    if (next) return { outcome: "switched", next };
    return { outcome: "waiting" };
  }
}
