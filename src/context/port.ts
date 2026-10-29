import { loadProject } from "../project";
import { giraAvailable, giraContext } from "./gira";

export interface ContextItem {
  path: string;
  line: number;
  symbol: string;
  kind: string;
  text: string;
}

export interface ContextResult {
  schema_version: number;
  provider: string;
  capability: string;
  items: ContextItem[];
  unsupported?: boolean;
}

export const SCHEMA_VERSION = 1;

/** Núcleo: `cap <arg>` exige argumento (usage exit 2). Extras (`gira:tour`) não. */
export const CORE_CAPS = ["outline", "slice", "impact"];

export function unsupportedResult(provider: string, capability: string): ContextResult {
  return { schema_version: SCHEMA_VERSION, provider, capability, items: [], unsupported: true };
}

export function okResult(provider: string, capability: string, items: ContextItem[]): ContextResult {
  return { schema_version: SCHEMA_VERSION, provider, capability, items };
}

export function capabilitiesToItems(names: string[]): ContextItem[] {
  return names.map((name) => ({
    path: name,
    line: 1,
    symbol: name,
    kind: "capability",
    text: name,
  }));
}

/** `[context].provider` do `.ginga/project.toml` (raiz = cwd); ausente → "gira". */
export function resolveProvider(root: string): string {
  const raw = loadProject(root).context.provider;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return "gira";
}

/** Provedor <comando> (estilo credential helper): `<comando> <cap> [arg] --json`; passa direto. */
function commandContext(provider: string, capability: string, arg: string | undefined): ContextResult {
  if (Bun.which(provider) === null) return unsupportedResult(provider, capability);
  const argv = [provider, capability, ...(arg !== undefined ? [arg] : []), "--json"];
  let r;
  try {
    r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  } catch {
    return unsupportedResult(provider, capability);
  }
  if ((r.exitCode ?? 1) !== 0) return unsupportedResult(provider, capability);
  let raw: unknown;
  try {
    raw = JSON.parse(r.stdout.toString());
  } catch {
    return unsupportedResult(provider, capability);
  }
  return normalizeSchema(raw, provider, capability);
}

/** Aceita a resposta do provedor no schema único; array de capacidades vira items; resto → unsupported. */
function normalizeSchema(raw: unknown, provider: string, capability: string): ContextResult {
  if (Array.isArray(raw)) {
    return okResult(provider, capability, capabilitiesToItems(raw.map(String)));
  }
  if (raw === null || typeof raw !== "object") return unsupportedResult(provider, capability);
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.items)) return unsupportedResult(provider, capability);
  const result: ContextResult = {
    schema_version: SCHEMA_VERSION,
    provider: typeof obj.provider === "string" && obj.provider ? obj.provider : provider,
    capability: typeof obj.capability === "string" && obj.capability ? obj.capability : capability,
    items: obj.items as ContextItem[],
  };
  if (obj.unsupported === true) result.unsupported = true;
  return result;
}

function dispatch(provider: string, capability: string, arg: string | undefined, cwd: string): ContextResult {
  if (provider === "gira") return giraContext(capability, arg, cwd);
  if (provider === "rg") return unsupportedResult("rg", capability); // implementado na TASK-05
  return commandContext(provider, capability, arg);
}

/** `manda context <cap> [arg] [--json]` → exit code do processo. */
export function contextMain(args: string[], cwd: string): number {
  const positionals = args.filter((a) => !a.startsWith("--"));
  const capability = positionals[0];
  if (capability === undefined) {
    console.error("Usage: manda context <capability> [arg] [--json]");
    return 2;
  }
  const arg = positionals[1];
  if (CORE_CAPS.includes(capability) && arg === undefined) {
    console.error(`Usage: manda context ${capability} <arg> [--json]`);
    return 2;
  }

  let provider = resolveProvider(cwd);
  if (provider === "gira" && !giraAvailable()) {
    console.error("aviso: binario gira nao encontrado no PATH; caindo para o fallback rg");
    provider = "rg";
  }

  console.log(JSON.stringify(dispatch(provider, capability, arg, cwd)));
  return 0;
}
