import type { KV } from "../storage";
import { MANAGED, Vault, type KeyStore, type VaultOptions } from "./vault";

/**
 * Opens the encrypted history only for someone who has an account or already has history here.
 * A signed-out first visit gets null: no IndexedDB key and no localStorage entry, so their
 * ghost chat leaves nothing in the browser (Vault.open would create the key).
 */
export async function openHistory(backing: KV, keys: KeyStore, signedIn: boolean, opts?: VaultOptions): Promise<Vault | null> {
  if (!signedIn && !MANAGED.some((k) => backing.getItem(k) != null)) return null;
  return Vault.open(backing, keys, opts);
}

/**
 * Homepage hand-off: `/chat?ghost=1#q=<encoded prompt>`. The prompt is read only from the
 * fragment, which browsers never send to a server; a `q` in the query string is ignored.
 */
export function readHandoff(loc: { search: string; hash: string }): { ghost: boolean; prompt: string } {
  const ghost = new URLSearchParams(loc.search).get("ghost") === "1";
  const prompt = (new URLSearchParams(loc.hash.replace(/^#/, "")).get("q") ?? "").trim();
  return { ghost, prompt };
}
