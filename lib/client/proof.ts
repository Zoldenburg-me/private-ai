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

export type ProofLevel = "verified" | "checks-passed" | "failed" | "unavailable" | "pending" | "no-enclave";

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
  else if (chainVerified && all.every((i) => i.state === "pass")) level = "verified";
  else level = "checks-passed";
  return { modelRef, level, label: LEVEL_LABEL[level], chainVerified: level === "verified", checkedAt: now, reports, notVerified: level === "verified" ? [] : NOT_VERIFIED, signingAddress };
}

export const LEVEL_LABEL: Record<ProofLevel, string> = {
  verified: "Verified",
  "checks-passed": "Enclave checks passed · chain not verified",
  failed: "Proof failed",
  unavailable: "No proof available",
  pending: "Checking proof…",
  "no-enclave": "No enclave · anonymized",
};

/** Anonymized models run at the model vendor: there is no enclave to attest, so nothing is fetched or claimed. */
export function noEnclaveProof(modelRef: string, now = Date.now()): Proof {
  return { modelRef, level: "no-enclave", label: LEVEL_LABEL["no-enclave"], chainVerified: false, checkedAt: now, reports: [], notVerified: [] };
}

export function proofFromResponse(modelRef: string, body: unknown, nonce: string): Proof {
  const j = (body ?? {}) as { gateway_attestation?: NearReport; model_attestations?: NearReport[] } & Partial<NearReport>;
  const reports: ReportProof[] = [];
  if (j.gateway_attestation) reports.push(buildReportProof(j.gateway_attestation, "gateway", nonce));
  for (const m of j.model_attestations ?? []) reports.push(buildReportProof(m, "model", nonce));
  if (!reports.length && j.intel_quote) reports.push(buildReportProof(j as NearReport, "model", nonce));
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
