import type { KV } from "./storage";

/**
 * The ONE gate for browser persistence. Every write to local storage (chats, personas,
 * backup restore, wipe) needs a `Writer`, and `persist()` is the only place that hands one out.
 * Ghost mode gets no Writer at all, so a ghost conversation cannot reach storage by any path.
 * (Lumo's ghost checks were per call site and one was missed; here it is structural.)
 */
declare const writerBrand: unique symbol;
export type Writer = KV & { readonly [writerBrand]: true };

export interface PersistMode { ghost: boolean }

export function persist<T>(kv: KV, mode: PersistMode, write: (w: Writer) => T): T | undefined {
  if (mode.ghost) return undefined;
  return write(kv as Writer);
}
