/* STUB — TASK-09 RED: outcome errado para provar RED por asserção.
 * O teste falha por asserção (não por import), provando RED. */
import type { Database } from "bun:sqlite";
import type { RunObs } from "./run_state";

export async function watchAttempt(_o: {
  sample: () => Promise<RunObs>;
  kill: () => void;
  probe: (m: string) => Promise<{ ok: boolean }>;
  db: Database;
  model: string;
  cfg: { patience_min: number; no_progress_min: number };
  sleep: (ms: number) => Promise<void>;
}): Promise<{ outcome: "done" | "switched" | "waiting"; next?: string }> {
  return { outcome: "done" }; // errado: deveria amostrar, classificar e reagir
}
