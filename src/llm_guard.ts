export interface LlmAgentCheck {
  refused: boolean;
  pid?: number;
  label?: string;
}

/** Esqueleto da T101: a implementação vem do executor. */
export function findLlmAgent(_startPid: number, _procRoot = "/proc"): LlmAgentCheck {
  return { refused: false };
}
