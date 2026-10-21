import { SecureClient } from "tinfoil";

let client: SecureClient | undefined;
/** A failed check is reused this long, so an outage does not turn every proof request into new attestation attempts. */
export const VERIFY_FAIL_CACHE_MS = 10_000;
let failedAt = -Infinity;

/**
 * fetch for the Tinfoil provider: the SDK verifies the enclave's attestation and code provenance,
 * then seals request bodies to the attested enclave key (EHBP). The path after `/v1` of the
 * configured base URL is sent to the verified enclave, so the rest of the relay stays unchanged.
 */
export const tinfoilFetch: typeof fetch = async (input, init) => {
  const c = (client ??= new SecureClient());
  await c.ready(); // the SDK resets itself when attestation fails, so the next request attests again
  failedAt = -Infinity; // attested again: the proof check need not wait out an earlier failure
  const url = new URL(input instanceof Request ? input.url : String(input));
  const path = url.pathname.replace(/^\/v1\/?/, "") + url.search;
  try {
    return await c.fetch(new URL(path, c.getBaseURL()), init);
  } catch (e) {
    // The SDK keeps its attestation after transport errors; the enclave may have moved, so attest again (not on a client abort).
    if (!(e instanceof Error && e.name === "AbortError")) c.reset();
    throw e;
  }
};


/**
 * Whether the Tinfoil SDK on this server holds a verified attestation (enclave + code provenance). The SDK keeps a
 * passing result until a request fails, then attests again; a failure here is remembered for VERIFY_FAIL_CACHE_MS.
 */
export async function tinfoilVerified(now = Date.now()): Promise<boolean> {
  if (now - failedAt < VERIFY_FAIL_CACHE_MS) return false;
  try { await (client ??= new SecureClient()).ready(); return true; } catch { failedAt = now; return false; }
}
