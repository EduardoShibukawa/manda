import {
  CORE_CAPS,
  capabilitiesToItems,
  okResult,
  unsupportedResult,
  type ContextItem,
  type ContextResult,
} from "./port";

/** gira falso dos testes vive em tests/fixtures/context/bin; Bun.which usa o PATH do processo. */
export function giraAvailable(): boolean {
  return Bun.which("gira") !== null;
}

interface GiraRun {
  ok: boolean;
  data: unknown;
}

function runGira(sub: string, arg: string | undefined, cwd: string, jsonFlag: "--format json" | "--json" | "" = "--format json"): GiraRun {
  const argv = ["gira", sub, ...(arg !== undefined ? [arg] : []), ...(jsonFlag === "" ? [] : jsonFlag.split(" "))];
  let r;
  try {
    r = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  } catch {
    return { ok: false, data: null };
  }
  if ((r.exitCode ?? 1) !== 0) return { ok: false, data: null };
  try {
    return { ok: true, data: JSON.parse(r.stdout.toString()) };
  } catch {
    return { ok: false, data: null };
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** node do gira → item do schema único (evidence[0].locator dá path/line; ts_kind ou kind dá kind). */
export function nodeToItem(node: unknown): ContextItem | null {
  const n = asRecord(node);
  if (!n) return null;
  const evidence = Array.isArray(n.evidence) ? n.evidence : [];
  const locator = asRecord(asRecord(evidence[0])?.locator) ?? {};
  const meta = asRecord(n.metadata) ?? {};
  const path = typeof locator.path === "string" && locator.path
    ? locator.path
    : typeof meta.declared_file === "string" && meta.declared_file
      ? meta.declared_file
      : null;
  if (path === null) return null;
  const line = Number.isInteger(locator.start_line) && Number(locator.start_line) > 0 ? Number(locator.start_line) : 1;
  const symbol = typeof n.name === "string" && n.name ? n.name : path;
  const kind = String(meta.ts_kind ?? n.kind ?? "node").toLowerCase();
  const text = typeof n.description === "string" ? n.description : symbol;
  return { path, line, symbol, kind, text };
}

function itemsFromNodes(data: unknown): ContextItem[] | null {
  if (!Array.isArray(data)) return null;
  const items = data.map(nodeToItem).filter((i): i is ContextItem => i !== null);
  return items;
}

/**
 * `gira-g@<sha>:caminho/relativo#Lx-Ly` → {path, line}. Sem ref (só `path#Lx`) usa a string toda.
 */
function parseReadRef(s: string): { path: string; line: number } {
  const hash = s.indexOf("#");
  const left = hash === -1 ? s : s.slice(0, hash);
  const colon = left.indexOf(":");
  const path = colon === -1 ? left : left.slice(colon + 1);
  const m = hash === -1 ? null : /L(\d+)/.exec(s.slice(hash + 1));
  return { path, line: m ? Number(m[1]) : 1 };
}

/** tour → items: cada step.read vira item (line do #Lx-Ly; symbol/text do step). */
function tourItems(data: unknown): ContextItem[] {
  const root = asRecord(data);
  const steps = Array.isArray(root?.steps) ? root!.steps : [];
  const items: ContextItem[] = [];
  for (const raw of steps) {
    const step = asRecord(raw);
    if (!step) continue;
    const title = typeof step.title === "string" && step.title ? step.title : String(step.order ?? "tour");
    const why = typeof step.why === "string" ? step.why : title;
    const reads = Array.isArray(step.read) ? step.read : [];
    for (const ref of reads) {
      if (typeof ref !== "string" || !ref) continue;
      const { path, line } = parseReadRef(ref);
      if (!path) continue;
      items.push({ path, line, symbol: title, kind: "tour-step", text: why });
    }
  }
  return items;
}

function capabilityItems(data: unknown): ContextItem[] {
  const names = Array.isArray(data) ? data.map(String) : [];
  return capabilitiesToItems(names);
}

/**
 * Adapter gira: `manda context <cap> <arg> --json` sobre o CLI do gira
 * (outline|slice|impact|tour) normalizado no schema único da porta.
 */
export function giraContext(capability: string, arg: string | undefined, cwd: string): ContextResult {
  if (capability === "capabilities") {
    const run = runGira("capabilities", undefined, cwd, "--json");
    const items = run.ok ? capabilityItems(run.data) : capabilitiesToItems(CORE_CAPS);
    return okResult("gira", "capabilities", items.length > 0 ? items : capabilitiesToItems(CORE_CAPS));
  }

  if (capability.startsWith("gira:")) {
    const sub = capability.slice("gira:".length);
    if (sub !== "tour") return unsupportedResult("gira", capability);
    const run = runGira(sub, arg, cwd);
    if (!run.ok) return unsupportedResult("gira", capability);
    return okResult("gira", capability, tourItems(run.data));
  }

  const run = runGira(capability, arg, cwd);
  if (!run.ok) return unsupportedResult("gira", capability);

  switch (capability) {
    case "outline": {
      const items = itemsFromNodes(run.data);
      return items === null ? unsupportedResult("gira", capability) : okResult("gira", capability, items);
    }
    case "slice": {
      const focal = asRecord(run.data)?.focal_node;
      const item = nodeToItem(focal);
      if (item === null) return unsupportedResult("gira", capability);
      return okResult("gira", capability, [item]);
    }
    case "impact": {
      const affected = asRecord(run.data)?.affected_contracts;
      const items = itemsFromNodes(affected);
      return items === null ? unsupportedResult("gira", capability) : okResult("gira", capability, items);
    }
    default:
      return unsupportedResult("gira", capability);
  }
}
