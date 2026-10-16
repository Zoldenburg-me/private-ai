import { createHash, timingSafeEqual } from "node:crypto";
import { metaLogger } from "./log";

let warned = false;
/** Test hook: lets the fail-open warning fire again. */
export const _resetInviteWarning = () => { warned = false; };

const norm = (s: string) => s.normalize("NFKC").trim();

/** INVITE_CODES, comma-separated. Empty = signup and anonymous chat open (dev); warned once in production. */
export function inviteCodes(): string[] {
  const codes = (process.env.INVITE_CODES ?? "").split(",").map(norm).filter(Boolean);
  if (codes.length === 0 && process.env.NODE_ENV === "production" && !warned) {
    warned = true;
    metaLogger({ event: "invite_gate_off" });
  }
  return codes;
}

/** Plain codes in env, like the other secrets. Equal-length digests; every code is always checked. */
export function inviteOk(code: unknown): boolean {
  const codes = inviteCodes();
  if (codes.length === 0) return true;
  if (typeof code !== "string" || !norm(code)) return false;
  const sha = (s: string) => createHash("sha256").update(s).digest();
  const d = sha(norm(code));
  return codes.reduce((ok, c) => timingSafeEqual(sha(c), d) || ok, false);
}
