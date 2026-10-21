import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { TDX, verifyReport, type AttestationReport, type Check } from "@/lib/attestation";

/**
 * Client-side proof model for the attestation badge + drawer.
 * Honesty rule: the word "Verified" is only ever produced when the full certificate chain
 * (Intel DCAP quote chain + TCB, and NVIDIA NRAS for GPU evidence) was verified.
 * Today nothing in this app verifies the chain, so the best state is "checks passed, chain unverified".
 */

/** Offsets inside a TDX quote (48-byte header + TD report body), per Intel TDX DCAP quote layout. */
const BODY = TDX.HEADER;
export const TD_FIELDS = {
  MRTD: BODY + 136,
  MRCONFIGID: BODY + 184,
  MROWNER: BODY + 232,
  MROWNERCONFIG: BODY + 280,
  RTMR0: BODY + 328,
  RTMR1: BODY + 376,
  RTMR2: BODY + 424,
  RTMR3: BODY + 472,
} as const;
export type MeasurementName = keyof typeof TD_FIELDS;

export interface Measurement { name: MeasurementName; value: string }

export function readMeasurements(quoteHex: string): Measurement[] {
  const b = hexToBytes(quoteHex.replace(/^0x/i, ""));
  if (b.length < TDX.MIN_LEN) return [];
  return (Object.keys(TD_FIELDS) as MeasurementName[]).map((name) => ({
    name, value: bytesToHex(b.slice(TD_FIELDS[name], TD_FIELDS[name] + 48)),
  }));
}

/** NEAR docs: MRCONFIGID must equal 0x01 || sha256(app_compose) || 15 zero bytes. */
export function expectedMrConfigId(appCompose: string): string {
  return "01" + bytesToHex(sha256(utf8ToBytes(appCompose))) + "00".repeat(15);
}

export interface NearReport extends AttestationReport {
  event_log?: unknown;
  /** RedPill's legacy report ("aci/…") attests its gateway, not the upstream model. */
  api_version?: unknown;
  info?: { tcb_info?: string | { app_compose?: string } };
}

function appComposeOf(r: NearReport): string | undefined {
  const t = r.info?.tcb_info;
  if (!t) return undefined;
  if (typeof t === "string") { try { return (JSON.parse(t) as { app_compose?: string }).app_compose; } catch { return undefined; } }
  return t.app_compose;
}

export type CheckState = "pass" | "fail" | "not-checked";
export interface ProofItem { id: string; label: string; state: CheckState; detail?: string; scope: string }

export interface ReportProof {
  role: "gateway" | "model";
  signingAddress: string;
  measurements: Measurement[];
  items: ProofItem[];
}

export type ProofLevel = "verified" | "checks-passed" | "gateway-checked" | "server-checked" | "failed" | "unavailable" | "pending" | "no-enclave";

export interface Proof {
  modelRef: string;
  level: ProofLevel;
  label: string;
  chainVerified: boolean;
  checkedAt: number;
  reports: ReportProof[];
  /** Things that are deliberately NOT verified by this client, shown in the drawer. */
  notVerified: string[];
  signingAddress?: string;
}

const CHECK_LABELS: Record<string, string> = {
  "nonce echoed": "Fresh: our nonce is echoed",
  "signing algo ecdsa": "Signing algorithm is ECDSA",
  "signing address format": "Signing address is well-formed",
  "quote parses": "Intel TDX quote parses",
  "debug mode off": "TD debug mode is off",
  "report_data binds signer+nonce": "Quote binds signer key + our nonce",
  "gpu evidence nonce": "GPU evidence carries our nonce",
};

const toItem = (c: Check, scope: string): ProofItem => ({
  id: c.name, label: CHECK_LABELS[c.name] ?? c.name, state: c.ok ? "pass" : "fail", detail: c.detail, scope,
});

export const NOT_VERIFIED = [
  "Intel DCAP certificate chain and TCB status of the TDX quote (needs dcap-qvl)",
  "NVIDIA GPU attestation via NRAS (only the nonce in the GPU evidence is compared)",
  "RTMR3 event-log replay",
  "Image provenance (that the measured compose matches published source)",
  "TLS binding between this browser and the enclave (our server relays traffic)",
];

export function buildReportProof(r: NearReport, role: ReportProof["role"], nonce: string): ReportProof {
  const v = verifyReport(r, nonce);
  const items = v.checks.map((c) => toItem(c, role));
  const measurements = (() => { try { return readMeasurements(r.intel_quote); } catch { return []; } })();
  const compose = appComposeOf(r);
  const mrcfg = measurements.find((m) => m.name === "MRCONFIGID")?.value;
  items.push(compose && mrcfg
    ? { id: "compose", label: "Measured config (MRCONFIGID) matches app_compose hash", state: mrcfg === expectedMrConfigId(compose) ? "pass" : "fail", scope: role }
    : { id: "compose", label: "Measured config (MRCONFIGID) matches app_compose hash", state: "not-checked", detail: "provider did not return app_compose", scope: role });
  items.push({ id: "dcap-chain", label: "Intel certificate chain + TCB", state: "not-checked", detail: "not verified in this client yet", scope: role });
  if (r.nvidia_payload) items.push({ id: "nras", label: "NVIDIA NRAS attestation", state: "not-checked", detail: "not verified in this client yet", scope: role });
  return { role, signingAddress: v.signingAddress ?? "", measurements, items };
}

/**
 * Overall level. "verified" requires chainVerified === true AND every item passed;
 * since chain checks are not implemented, callers get "checks-passed" at best.
 */
export function summarise(modelRef: string, reports: ReportProof[], chainVerified = false, now = Date.now()): Proof {
  const all = reports.flatMap((r) => r.items);
  const failed = all.some((i) => i.state === "fail");
  const signingAddress = reports.find((r) => r.role === "model")?.signingAddress ?? reports[0]?.signingAddress;
  let level: ProofLevel;
  if (!reports.length) level = "unavailable";
  else if (failed) level = "failed";
  // Only a gateway attested (e.g. RedPill's aci/ report): the model behind it is not, so no enclave claim for the model.
  else if (!reports.some((r) => r.role === "model")) level = "gateway-checked";
  else if (chainVerified && all.every((i) => i.state === "pass")) level = "verified";
  else level = "checks-passed";
  return { modelRef, level, label: LEVEL_LABEL[level], chainVerified: level === "verified", checkedAt: now, reports, notVerified: level === "verified" ? [] : NOT_VERIFIED, signingAddress };
}

export const LEVEL_LABEL: Record<ProofLevel, string> = {
  verified: "Verified",
  "checks-passed": "Enclave checks passed · chain not verified",
  "gateway-checked": "Gateway checks passed · model not attested",
  "server-checked": "Checked by our server · Tinfoil SDK",
  failed: "Proof failed",
  unavailable: "No proof available",
  pending: "Checking proof…",
  "no-enclave": "No enclave · anonymized",
};

/** Anonymized models run at the model vendor: there is no enclave to attest, so nothing is fetched or claimed. */
export function noEnclaveProof(modelRef: string, now = Date.now()): Proof {
  return { modelRef, level: "no-enclave", label: LEVEL_LABEL["no-enclave"], chainVerified: false, checkedAt: now, reports: [], notVerified: [] };
}

/**
 * Tinfoil: lib/tinfoil.ts sends nothing until the Tinfoil SDK on our server has verified the enclave's attestation
 * and code provenance, and its reports are not NEAR-shaped, so this browser cannot re-check them. Say exactly that.
 * Only for a `server_checked: true` answer from /api/attestation, i.e. after the SDK passed on our server.
 */
export function serverCheckedProof(modelRef: string, now = Date.now()): Proof {
  return { modelRef, level: "server-checked", label: LEVEL_LABEL["server-checked"], chainVerified: false, checkedAt: now, reports: [],
    notVerified: ["Tinfoil's attestation and code provenance: verified by the Tinfoil SDK on our server, which keeps the result until a request fails and then attests again; not checked in this browser"] };
}

/** Our server's /api/attestation answer for a Tinfoil model: passing only if the SDK check ran and passed there. */
export function tinfoilProof(modelRef: string, body: unknown, now = Date.now()): Proof {
  return (body as { server_checked?: unknown } | null)?.server_checked === true ? serverCheckedProof(modelRef, now)
    : { modelRef, level: "unavailable", label: LEVEL_LABEL.unavailable, chainVerified: false, checkedAt: now, reports: [], notVerified: [] };
}

const PASSING: ProofLevel[] = ["verified", "checks-passed", "server-checked"];

/** Auto: check routes in order (cheapest first) and return the first proof that holds, or undefined if none does. */
export async function firstPassing(routes: string[], check: (ref: string) => Promise<Proof | null>): Promise<Proof | undefined> {
  for (const r of routes) {
    const p = await check(r);
    if (p && PASSING.includes(p.level)) return p;
  }
  return undefined;
}

export function proofFromResponse(modelRef: string, body: unknown, nonce: string): Proof {
  const j = (body ?? {}) as { gateway_attestation?: NearReport; model_attestations?: NearReport[] } & Partial<NearReport>;
  const reports: ReportProof[] = [];
  if (j.gateway_attestation) reports.push(buildReportProof(j.gateway_attestation, "gateway", nonce));
  // With its own gateway report present, the tag cannot relabel model reports (that would move the signing key to the gateway's).
  const roleOf = (r: NearReport): ReportProof["role"] =>
    (!j.gateway_attestation && typeof r.api_version === "string" && r.api_version.startsWith("aci/") ? "gateway" : "model");
  for (const m of j.model_attestations ?? []) reports.push(buildReportProof(m, roleOf(m), nonce));
  if (!reports.length && j.intel_quote) reports.push(buildReportProof(j as NearReport, roleOf(j as NearReport), nonce));
  return summarise(modelRef, reports, false);
}

/**
 * Per-reply signature status. "enclave" needs a chain-verified quote; while the chain is unchecked the
 * signing key comes from an unverified quote, so a matching signature is only "key-match".
 */
export type Signed = "enclave" | "key-match" | "fail" | "n/a";

export function signatureLevel(proof: Pick<Proof, "chainVerified">, signatureOk: boolean): Signed {
  if (!signatureOk) return "fail";
  return proof.chainVerified ? "enclave" : "key-match";
}

/** Reads a stored status; legacy "ok" was written without chain verification, so it is a key match. */
export function normalizeSigned(s: unknown): Signed | undefined {
  if (s === "ok") return "key-match";
  return s === "enclave" || s === "key-match" || s === "fail" || s === "n/a" ? s : undefined;
}
