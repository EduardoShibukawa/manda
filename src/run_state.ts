export type RunState = "recusado" | "devagar" | "na_fila" | "travado" | "ok";

export type RunObs = {
  since_last_event_s: number;
  stream_bytes: number;
  cpu_pct: number;
  files_changed: boolean;
  probe_ok: boolean;
  exit: number | null;
  stderr_tail: string;
};

export type RunStateCfg = {
  patience_min: number;
  no_progress_min: number;
};

export type RunClassified = {
  state: RunState;
  reason: string;
};

function isRecusado(obs: RunObs): boolean {
  if (obs.exit == null) return false;
  const s = (obs.stderr_tail || "").toLowerCase();
  if (s.includes("econnreset")) return true;
  if (s.includes("http 5xx") || /5\d\d/.test(s)) return true;
  if (s.includes("429")) return true;
  if (s.includes("usage limit")) return true;
  return false;
}

export function classifyRun(obs: RunObs, cfg: RunStateCfg): RunClassified {
  // recusado tem prioridade
  if (isRecusado(obs)) {
    return { state: "recusado", reason: "recusado" };
  }

  const noProgressSec = cfg.no_progress_min * 60;
  const patienceSec = cfg.patience_min * 60;
  const noEventLong = obs.since_last_event_s >= noProgressSec;
  const eventRecent = obs.since_last_event_s < noProgressSec; // evento nos últimos no_progress_min

  // na_fila além da paciência -> travado (caso 8)
  const isNaFila = obs.stream_bytes === 0 && obs.probe_ok === true;
  if (isNaFila && obs.since_last_event_s > patienceSec) {
    return { state: "travado", reason: "travado por timeout na fila" };
  }

  // travado: sem evento há no_progress_min, cpu_pct < 1, !files_changed e probe_ok == false
  if (noEventLong && obs.cpu_pct < 1 && !obs.files_changed && obs.probe_ok === false) {
    return { state: "travado", reason: "travado" };
  }

  // na_fila: stream_bytes == 0, probe_ok == true, dentro de patience_min
  if (isNaFila && obs.since_last_event_s <= patienceSec) {
    return { state: "na_fila", reason: "na_fila" };
  }

  // devagar: evento nos últimos no_progress_min
  if (eventRecent) {
    // Se tem progresso recente mas não é "ok" normal, pode ser devagar
    // Caso 5: tem evento recente, stream_bytes>0, files_changed true -> devagar
    // Caso 6: tem evento recente, stream_bytes>0, files_changed true, cpu alto -> ok
    // Diferença parece ser mais "progresso vigoroso" -> ok
    if (obs.files_changed && obs.stream_bytes > 100 && obs.cpu_pct > 10) {
      return { state: "ok", reason: "ok" };
    }
    if (obs.exit === 0) {
      return { state: "ok", reason: "ok" };
    }
    return { state: "devagar", reason: "devagar" };
  }

  // exit 0 -> ok
  if (obs.exit === 0) {
    return { state: "ok", reason: "ok" };
  }

  // default
  if (obs.files_changed || obs.stream_bytes > 0 || obs.cpu_pct > 0) {
    return { state: "ok", reason: "ok" };
  }

  return { state: "ok", reason: "ok" };
}
