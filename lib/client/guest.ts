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

/** Longest invite code we accept from a link: the server rejects longer admin-panel codes (lib/invite.ts); keep env codes shorter too. */
const MAX_INVITE = 128;

/**
 * Homepage hand-off `/chat?ghost=1#q=<encoded prompt>` and invite links `/chat#invite=<code>`. The prompt
 * and the code are read only from the fragment, which browsers never send to a server; the same names in
 * the query string are ignored. The caller keeps the code in memory only.
 */
export function readHandoff(loc: { search: string; hash: string }): { ghost: boolean; prompt: string; invite: string } {
  const ghost = new URLSearchParams(loc.search).get("ghost") === "1";
  const frag = new URLSearchParams(loc.hash.replace(/^#/, ""));
  const prompt = (frag.get("q") ?? "").trim();
  const invite = (frag.get("invite") ?? "").trim();
  return { ghost, prompt, invite: invite.length <= MAX_INVITE ? invite : "" };
}

/** The link an admin sends: the code sits in the fragment, so it never reaches a server log. */
export const inviteLink = (origin: string, code: string) => `${origin}/chat#invite=${encodeURIComponent(code)}`;

const inviteRequired = async (r: Response) =>
  r.status === 403 && (await r.clone().json().catch(() => null))?.error?.code === "invite_required";

/**
 * Passkey signup options with an invite: tries the code from the link first and asks only if there is none
 * or it was not accepted (then `forget` drops it, so a retry does not spend another failed guess).
 * Returns null when the visitor cancels the prompt.
 */
export async function withInvite(send: (invite?: string) => Promise<Response>, held: string, ask: (message: string) => string | null, forget: () => void = () => {}): Promise<Response | null> {
  const r = await send(held || undefined);
  if (!(await inviteRequired(r))) return r;
  if (held) forget();
  const code = ask(held ? "The code from your invite link was not accepted. Enter an invite code" : "Invite code")?.trim();
  return code ? send(code) : null;
}
