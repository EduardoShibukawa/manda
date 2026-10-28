type Attestation = Record<string, unknown>;

export const FAMILY_ALIASES: ReadonlyArray<readonly [prefix: string, family: string]> = [
  ["claude", "claude"],
  ["opus", "claude"],
  ["sonnet", "claude"],
  ["haiku", "claude"],
  ["gemini", "gemini"],
  ["gemma", "gemini"],
  ["gpt", "gpt"],
  ["chatgpt", "gpt"],
  ["codex", "gpt"],
  ["o1", "gpt"],
  ["o3", "gpt"],
  ["o4", "gpt"],
  ["qwen", "qwen"],
  ["qwq", "qwen"],
  ["deepseek", "deepseek"],
  ["glm", "glm"],
  ["chatglm", "glm"],
  ["zhipu", "glm"],
  ["minimax", "minimax"],
  ["abab", "minimax"],
  ["kimi", "kimi"],
  ["moonshot", "kimi"],
  ["llama", "llama"],
  ["meta", "llama"],
  ["mistral", "mistral"],
  ["mixtral", "mistral"],
  ["codestral", "mistral"],
  ["devstral", "mistral"],
  ["magistral", "mistral"],
  ["ornith", "ornith"],
  ["mimo", "mimo"],
  ["longcat", "longcat"],
  ["nemotron", "nemotron"],
  ["grok", "grok"],
];

const EXACT_ONLY_ALIASES = new Set(["o1", "o3", "o4"]);

const PROVIDER_PREFIX =
  /^(?:(?:us|eu|apac|global)\.)?(?:anthropic|google|meta|mistral|amazon|openai)\./;

const QUANT_SUFFIX = /-(I?Q\d[\w]*|F16|BF16|F32)$/i;

export function modelFamily(model: string | null | undefined): string {
  let m = model === null || model === undefined ? "" : model.trim().toLowerCase();
  if (m.length === 0) return "unknown";

  const slash = m.lastIndexOf("/");
  if (slash !== -1) m = m.slice(slash + 1);

  // Remove sufixo :tag e .gguf
  m = m.replace(/:[^:]*$/, "");
  m = m.replace(/\.gguf$/, "");

  m = m.replace(PROVIDER_PREFIX, "");

  const head = m.split(/[.\-_\s]/)[0] ?? "";
  if (head.length === 0) return "unknown";

  for (const [prefix, family] of FAMILY_ALIASES) {
    if (EXACT_ONLY_ALIASES.has(prefix)) {
      if (head === prefix) return family;
    } else if (head === prefix || head.startsWith(prefix)) {
      return family;
    }
  }
  return head;
}

export function normalizeServedId(rawId: string): string {
  let id = rawId;
  const slash = id.lastIndexOf("/");
  if (slash !== -1) id = id.slice(slash + 1);
  id = id.replace(/\.gguf$/, "");
  while (true) {
    const next = id.replace(QUANT_SUFFIX, "");
    if (next === id) break;
    id = next;
  }
  return id.toLowerCase();
}

export type AttestResult =
  | { ok: true; attested: Attestation }
  | { ok: false; reason_code: "infra" | "model_unattested"; error: string };

export function servedFromModels(
  body: unknown,
  claimed: string | null,
):
  | { ok: true; served: string }
  | { ok: false; reason_code: "infra" | "model_unattested"; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason_code: "infra", error: "resposta /v1/models inválida" };
  }
  const b = body as Record<string, unknown>;
  const data = Array.isArray(b.data) ? b.data : null;
  const models = Array.isArray(b.models) ? b.models : null;
  if (data === null && models === null) {
    return { ok: false, reason_code: "infra", error: "resposta /v1/models inválida" };
  }

  const ids: string[] = [];
  if (data !== null) {
    for (const item of data) {
      const id =
        typeof item === "object" && item !== null
          ? (item as Record<string, unknown>).id
          : undefined;
      if (typeof id === "string") ids.push(normalizeServedId(id));
    }
  } else if (models !== null) {
    for (const item of models) {
      const id =
        typeof item === "object" && item !== null
          ? (item as Record<string, unknown>).model
          : undefined;
      if (typeof id === "string") ids.push(normalizeServedId(id));
    }
  }

  if (ids.length === 0) {
    return { ok: false, reason_code: "model_unattested", error: "nenhum modelo servido" };
  }

  if (claimed !== null) {
    const norm = normalizeServedId(claimed);
    if (ids.includes(norm)) return { ok: true, served: norm };
  }

  if (ids.length === 1) return { ok: true, served: ids[0]! };

  return { ok: false, reason_code: "model_unattested", error: "endpoint ambíguo: vários modelos servidos" };
}

export async function attestFromEndpoint(
  endpoint: string,
  claimed: string | null,
  opts?: { timeoutMs?: number },
): Promise<AttestResult> {
  const base = endpoint.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/v1/models`, {
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 5000),
    });
  } catch (err) {
    return { ok: false, reason_code: "infra", error: (err as Error).message };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason_code: "infra",
      error: `GET /v1/models HTTP ${res.status}`,
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    return { ok: false, reason_code: "infra", error: "JSON inválido em /v1/models" };
  }
  const served = servedFromModels(body, claimed);
  if (!served.ok) return { ok: false, reason_code: served.reason_code, error: served.error };
  return {
    ok: true,
    attested: { claimed, served: served.served, via: "/v1/models" },
  };
}

export function attestFromTranscript(
  text: string,
  claimed: string | null,
): AttestResult {
  const counts = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // linha inválida: pulada
    }
    if (typeof obj !== "object" || obj === null) continue;
    const o = obj as Record<string, unknown>;
    const raw =
      typeof o.message === "object" && o.message !== null
        ? (o.message as Record<string, unknown>).model
        : undefined;
    const rawRoot = o.model;
    const modelRaw =
      typeof raw === "string" && raw.length > 0
        ? raw
        : typeof rawRoot === "string" && rawRoot.length > 0
          ? rawRoot
          : null;
    if (modelRaw === null || modelRaw === "<synthetic>") continue;
    const model = modelRaw.toLowerCase();
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return {
      ok: false,
      reason_code: "model_unattested",
      error: "transcript sem modelo",
    };
  }

  const families = new Set([...counts.keys()].map((m) => modelFamily(m)));
  if (families.size > 1) {
    return {
      ok: false,
      reason_code: "model_unattested",
      error: "transcript com várias famílias",
    };
  }

  let served: string | null = null;
  let best = -1;
  for (const [model, n] of counts) {
    if (n > best || (n === best && model < served!)) {
      served = model;
      best = n;
    }
  }

  return {
    ok: true,
    attested: { claimed, served: served!, via: "transcript" },
  };
}