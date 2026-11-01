import { describe, expect, test } from "bun:test";
import { classifyRun, type RunObs, type RunState } from "../src/run_state";

/**
 * Tabela de 8 observações cobrindo devagar, na_fila, travado, recusado e ok.
 * Unidades: since_last_event_s em segundos; *_min em minutos (×60 no classifyRun).
 */
const cfg = { patience_min: 5, no_progress_min: 2 };

const CASES: Array<{ name: string; obs: RunObs; want: RunState; reasonRegex: RegExp }> = [
  {
    name: "recusado: ECONNRESET",
    obs: { since_last_event_s: 0, stream_bytes: 100, cpu_pct: 50, files_changed: true, probe_ok: true, exit: 1, stderr_tail: "ECONNRESET Connection reset by peer" },
    want: "recusado",
    reasonRegex: /recusado/i,
  },
  {
    name: "recusado: 429 usage limit",
    obs: { since_last_event_s: 0, stream_bytes: 0, cpu_pct: 0, files_changed: false, probe_ok: false, exit: 1, stderr_tail: "429 Too Many Requests — usage limit reached" },
    want: "recusado",
    reasonRegex: /recusado/i,
  },
  {
    name: "travado: sem evento há no_progress_min, cpu zilhada, sem files, probe falha",
    obs: { since_last_event_s: 180, stream_bytes: 0, cpu_pct: 0.5, files_changed: false, probe_ok: false, exit: null, stderr_tail: "" },
    want: "travado",
    reasonRegex: /travado/i,
  },
  {
    name: "na_fila: sem bytes, probe ok, dentro de patience",
    obs: { since_last_event_s: 30, stream_bytes: 0, cpu_pct: 1, files_changed: false, probe_ok: true, exit: null, stderr_tail: "" },
    want: "na_fila",
    reasonRegex: /na_fila/i,
  },
  {
    name: "devagar: evento recente dentro de no_progress_min",
    obs: { since_last_event_s: 30, stream_bytes: 10, cpu_pct: 5, files_changed: true, probe_ok: true, exit: null, stderr_tail: "" },
    want: "devagar",
    reasonRegex: /devagar/i,
  },
  {
    name: "ok: progresso normal com eventos recentes e files changed",
    obs: { since_last_event_s: 5, stream_bytes: 500, cpu_pct: 40, files_changed: true, probe_ok: true, exit: null, stderr_tail: "" },
    want: "ok",
    reasonRegex: /ok/i,
  },
  {
    name: "ok: processo completou normalmente (exit 0)",
    obs: { since_last_event_s: 0, stream_bytes: 200, cpu_pct: 0, files_changed: true, probe_ok: true, exit: 0, stderr_tail: "" },
    want: "ok",
    reasonRegex: /ok/i,
  },
  {
    name: "travado: na_fila além da paciência (sem evento há no_progress_min, cpu zilhada, sem files, probe ok mas timeout estourado)",
    obs: { since_last_event_s: 400, stream_bytes: 0, cpu_pct: 0, files_changed: false, probe_ok: true, exit: null, stderr_tail: "" },
    want: "travado",
    reasonRegex: /travado|na_fila/i,
  },
];

describe("classifyRun", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const r = classifyRun(c.obs, cfg);
      expect(r.state).toBe(c.want);
      expect(r.reason).toMatch(c.reasonRegex);
    });
  }
});
