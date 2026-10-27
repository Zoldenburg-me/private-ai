import { UPSTREAM_TIMEOUT_MS } from "./catalog";
import { identityFrom } from "./session";
import { withStores } from "./store";
import { LIMITS, overLimit } from "./limits";
import { metaLogger } from "./log";

/**
 * Intel's DCAP collateral for the browser's quote check (lib/client/e2e/dcap.ts, docs/e2e-enclave-encryption.md
 * §3 check 3 and §4 "Speed and the first message"). It is Intel-signed and checked in the browser, so this cache
 * cannot fake it; it only saves the first user after a restart the wait for Intel. Process memory only: no Redis
 * key, no stored field, so nothing for lib/data-inventory.ts. Fetched by this server, so no CSP origin.
 */
const PCS = "https://api.trustedservices.intel.com";
const ROOT_CRL = "https://certificates.trustedservices.intel.com/IntelSGXRootCA.der";
/** Platforms whose TCB info is filled at startup; others are fetched on first use and then kept fresh too. */
export const PREFETCH_FMSPCS = ["B0C06F000000", "90C06F000000"];
/** Refetch an entry this old. Intel reissues hourly; the browser accepts collateral up to MAX_COLLATERAL_AGE_MS (days). */
export const REFRESH_MS = 60 * 60_000;
/** While Intel is unreachable, serve the last good entry this long, well inside the browser's maximum age. */
export const STALE_MAX_MS = 24 * 60 * 60_000;
const MAX_FMSPCS = 32;
const MAX_BYTES = 256 * 1024;

type Part = Record<string, string>;
// Shared via globalThis: Next bundles instrumentation.ts and each route separately; module state would be per-bundle.
type State = { cache: Map<string, { at: number; part: Part }>; inflight: Map<string, Promise<Part>>; timer?: ReturnType<typeof setInterval> };
const g = globalThis as unknown as { __paiCollateral?: State };
const state = (): State => (g.__paiCollateral ??= { cache: new Map(), inflight: new Map() });

async function fetchIntel(url: string, fetchImpl: typeof fetch): Promise<{ r: Response; body: ArrayBuffer }> {
  const r = await fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (Number(r.headers.get("content-length")) > MAX_BYTES) throw new Error("collateral upstream");
  const body = await r.arrayBuffer();
  if (!r.ok || body.byteLength > MAX_BYTES) throw new Error("collateral upstream");
  return { r, body };
}

/** The signed object exactly as Intel sent it (the signature covers these bytes), its signature, and its issuer chain. */
async function signedJson(url: string, field: string, chainHeader: string, out: string, fetchImpl: typeof fetch): Promise<Part> {
  const { r, body } = await fetchIntel(url, fetchImpl);
  const m = new RegExp(`^\\{"${field}":(\\{[\\s\\S]*\\}),"signature":"([0-9a-fA-F]{128})"\\}$`).exec(new TextDecoder().decode(body));
  const chain = r.headers.get(chainHeader);
  if (!m || !chain) throw new Error("collateral format");
  return { [out]: m[1], [`${out}_signature`]: m[2], [`${out}_issuer_chain`]: decodeURIComponent(chain) };
}

const der = async (url: string, out: string, fetchImpl: typeof fetch): Promise<Part> =>
  ({ [out]: Buffer.from((await fetchIntel(url, fetchImpl)).body).toString("hex") });

/** Keys: "root", "pck:platform", "pck:processor", "qe", "tcb:<FMSPC>". */
function load(key: string, fetchImpl: typeof fetch): Promise<Part> {
  if (key === "root") return der(ROOT_CRL, "root_ca_crl", fetchImpl);
  if (key === "qe") return signedJson(`${PCS}/tdx/certification/v4/qe/identity`, "enclaveIdentity", "SGX-Enclave-Identity-Issuer-Chain", "qe_identity", fetchImpl);
  const [kind, arg] = key.split(":");
  if (kind === "pck") return der(`${PCS}/sgx/certification/v4/pckcrl?ca=${arg}&encoding=der`, "pck_crl", fetchImpl);
  return signedJson(`${PCS}/tdx/certification/v4/tcb?fmspc=${arg}`, "tcbInfo", "TCB-Info-Issuer-Chain", "tcb_info", fetchImpl);
}

/** One fetch per key at a time; a new FMSPC beyond MAX_FMSPCS (prefetched ones aside) is served but not kept. */
function refresh(key: string, fetchImpl: typeof fetch): Promise<Part> {
  const { cache, inflight } = state();
  let p = inflight.get(key);
  if (!p) {
    p = load(key, fetchImpl)
      .then((part) => {
        const tcbs = [...cache.keys()].filter((k) => k.startsWith("tcb:")).length;
        if (cache.has(key) || !key.startsWith("tcb:") || PREFETCH_FMSPCS.includes(key.slice(4)) || tcbs < MAX_FMSPCS) cache.set(key, { at: Date.now(), part });
        return part;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

const age = (key: string) => Date.now() - (state().cache.get(key)?.at ?? -Infinity);

/** A fresh entry as is; a stale one (up to STALE_MAX_MS) at once while it refetches in the background; otherwise a wait for Intel. */
async function part(key: string, fetchImpl: typeof fetch): Promise<Part> {
  const hit = state().cache.get(key);
  if (hit && age(key) >= REFRESH_MS && age(key) < STALE_MAX_MS) refresh(key, fetchImpl).catch(() => {}); // the next refresh tick retries
  if (hit && age(key) < STALE_MAX_MS) return hit.part;
  return refresh(key, fetchImpl);
}

/** Fill the shared parts and PREFETCH_FMSPCS now, then refresh every cached entry before it goes stale. */
export function startCollateralCache(fetchImpl: typeof fetch = fetch): () => Promise<void> {
  const run = async () => {
    const keys = new Set(["root", "pck:platform", "pck:processor", "qe", ...PREFETCH_FMSPCS.map((f) => `tcb:${f}`), ...state().cache.keys()]);
    const failed = (await Promise.allSettled([...keys].map((k) => refresh(k, fetchImpl)))).filter((r) => r.status === "rejected").length;
    if (failed) metaLogger({ event: "collateral_refresh_failed", status: 502, outputBytes: failed });
  };
  void run();
  const s = state();
  if (!s.timer) s.timer = setInterval(run, REFRESH_MS / 2).unref(); // one timer, even if register() runs twice
  return run;
}

const fail = (status: number, message: string) => Response.json({ error: { message } }, { status, headers: { "Cache-Control": "no-store" } });

/** GET ?fmspc=<12 hex>&ca=platform|processor → dcap-qvl QuoteCollateralV3 fields. Needs a session; a wait for Intel counts as an evidence fetch (per account and overall). */
export const collateralRoute = (fetchImpl: typeof fetch = fetch) => withStores(async (req: Request): Promise<Response> => {
  const id = await identityFrom(req); if (!id) return fail(401, "missing or invalid session token");
  const url = new URL(req.url);
  const fmspc = (url.searchParams.get("fmspc") ?? "").toUpperCase();
  const ca = url.searchParams.get("ca");
  if (!/^[0-9A-F]{12}$/.test(fmspc) || (ca !== "platform" && ca !== "processor")) return fail(400, "fmspc=<12 hex> and ca=platform|processor required");
  const keys = ["root", `pck:${ca}`, "qe", `tcb:${fmspc}`];
  if (!keys.every((k) => age(k) < STALE_MAX_MS)) {
    const limited = await overLimit(LIMITS.evidence, `evidence:${id}`) ?? await overLimit(LIMITS.evidenceAll, "evidence-all"); if (limited) return limited;
  }
  try {
    return Response.json(Object.assign({}, ...(await Promise.all(keys.map((k) => part(k, fetchImpl))))), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return fail(502, "collateral unavailable");
  }
});

export function _clearCollateral() { clearInterval(g.__paiCollateral?.timer); g.__paiCollateral = undefined; }
