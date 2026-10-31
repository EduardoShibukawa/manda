export type Runner = (argv: string[], o: { stdin: "ignore"; timeout_ms: number }) => Promise<{ code: number; stdout: string }>;

export function probeArgv(model: string): string[] {
  // opencode/* and opencode-go/* use opencode run
  if (model.startsWith("opencode/") || model.startsWith("opencode-go/")) {
    return ["opencode", "run", "--standalone", "--auto", "-m", model, "responda só: ok"];
  }
  if (model.startsWith("pi:")) {
    // pi:* format - strip pi: prefix for model name
    const m = model.slice("pi:".length);
    return ["pi", "-p", "--model", m, "responda só: ok"];
  }
  if (model.startsWith("pi/")) {
    const m = model.slice("pi/".length);
    return ["pi", "-p", "--model", m, "responda só: ok"];
  }
  if (model.startsWith("claude/")) {
    const m = model.slice("claude/".length);
    return ["claude", "-p", "--model", m, "responda só: ok"];
  }
  // fallback - treat as opencode style if contains opencode
  if (model.includes("opencode")) {
    return ["opencode", "run", "--standalone", "--auto", "-m", model, "responda só: ok"];
  }
  // default fallback
  return ["opencode", "run", "--standalone", "--auto", "-m", model, "responda só: ok"];
}

const DEFAULT_TIMEOUT = 30_000;

export async function probe(model: string, runner: Runner, timeout_ms: number = DEFAULT_TIMEOUT): Promise<{ ok: boolean; ms: number }> {
  const start = Date.now();
  const argv = probeArgv(model);
  const res = await runner(argv, { stdin: "ignore", timeout_ms });
  const elapsed = Date.now() - start;
  if (res.code !== 0) {
    return { ok: false, ms: elapsed };
  }
  if (typeof res.stdout === "string" && res.stdout.includes("ok")) {
    return { ok: true, ms: elapsed };
  }
  return { ok: false, ms: elapsed };
}
