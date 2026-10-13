/**
 * Metadata-only logger. The ONLY way server code may log. It accepts a fixed set of
 * metadata fields; anything else (prompts, completions, bodies) is dropped by construction.
 */
export interface LogMeta {
  route?: string; provider?: string; model?: string; status?: number; ms?: number;
  tier?: string; event?: string; inputChars?: number; outputBytes?: number;
}
const ALLOWED: (keyof LogMeta)[] = ["route", "provider", "model", "status", "ms", "tier", "event", "inputChars", "outputBytes"];

export type Logger = (meta: LogMeta) => void;

export function sanitise(meta: Record<string, unknown>): LogMeta {
  const out: Record<string, unknown> = {};
  for (const k of ALLOWED) {
    const v = meta[k];
    if (typeof v === "number") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 80);
  }
  return out as LogMeta;
}

export const metaLogger: Logger = (meta) => {
  if (process.env.PAI_LOG === "off") return;
  console.log(JSON.stringify({ t: new Date().toISOString(), ...sanitise(meta as Record<string, unknown>) }));
};
