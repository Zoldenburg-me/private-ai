import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from "@noble/hashes/utils";

/**
 * Attestation checks written from NEAR AI Cloud's public verification docs
 * (docs.near.ai, "Quote, Nonce, and Signer Bindings"). Works in browser and Node.
 *
 * What we check locally:
 *  - echoed nonce == client nonce
 *  - TDX quote parses; TD debug attribute is OFF
 *  - quote report_data == pad32(signing_address) || nonce   (binds signer + freshness)
 *  - NVIDIA payload nonce == client nonce (when present)
 * NOT checked locally yet: Intel DCAP certificate chain / TCB status (needs dcap-qvl) and NVIDIA NRAS.
 * We surface that as `chainVerified: false` so the UI never overclaims.
 */

export interface AttestationReport {
  signing_address: string;
  signing_algo?: string;
  intel_quote: string;
  nvidia_payload?: string;
  request_nonce?: string;
}

export interface Check { name: string; ok: boolean; detail?: string }
export interface VerifyResult { ok: boolean; checks: Check[]; signingAddress?: string; chainVerified: boolean }

const strip0x = (h: string) => h.replace(/^0x/i, "").toLowerCase();

/** TDX quote v4/v5 layout: 48-byte header, then TD report body. */
export const TDX = { HEADER: 48, TD_ATTRIBUTES: 48 + 120, REPORT_DATA: 48 + 520, MIN_LEN: 48 + 584 };

export function parseTdxQuote(hex: string): { version: number; debug: boolean; reportData: Uint8Array } {
  const b = hexToBytes(strip0x(hex));
  if (b.length < TDX.MIN_LEN) throw new Error("quote too short");
  const version = b[0] | (b[1] << 8);
  const debug = (b[TDX.TD_ATTRIBUTES] & 0x01) === 0x01;
  return { version, debug, reportData: b.slice(TDX.REPORT_DATA, TDX.REPORT_DATA + 64) };
}

export function newNonce(): string {
  const n = new Uint8Array(32); globalThis.crypto.getRandomValues(n); return bytesToHex(n);
}

export function verifyReport(report: AttestationReport, nonceHex: string): VerifyResult {
  const checks: Check[] = [];
  const nonce = strip0x(nonceHex);
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  add("nonce echoed", !report.request_nonce || strip0x(report.request_nonce) === nonce);
  add("signing algo ecdsa", (report.signing_algo ?? "ecdsa") === "ecdsa");
  let addr: Uint8Array | null = null;
  try { addr = hexToBytes(strip0x(report.signing_address)); add("signing address format", addr.length === 20); }
  catch { add("signing address format", false); }

  try {
    const q = parseTdxQuote(report.intel_quote);
    add("quote parses", true, `v${q.version}`);
    add("debug mode off", !q.debug);
    if (addr) {
      const expected = concatBytes(addr, new Uint8Array(12), hexToBytes(nonce));
      add("report_data binds signer+nonce", bytesToHex(q.reportData) === bytesToHex(expected));
    }
  } catch (e) { add("quote parses", false, (e as Error).message); }

  if (report.nvidia_payload) {
    try { const p = JSON.parse(report.nvidia_payload) as { nonce?: string }; add("gpu evidence nonce", strip0x(p.nonce ?? "") === nonce); }
    catch { add("gpu evidence nonce", false, "malformed"); }
  }
  return { ok: checks.every((c) => c.ok), checks, signingAddress: (report.signing_address ?? "").toLowerCase(), chainVerified: false };
}

/** Ethereum personal_sign recovery (EIP-191). */
export function recoverAddress(text: string, signatureHex: string): string {
  const msg = utf8ToBytes(text);
  const hash = keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), msg));
  const sig = hexToBytes(strip0x(signatureHex));
  if (sig.length !== 65) throw new Error("bad signature length");
  let v = sig[64]; if (v >= 27) v -= 27;
  const pub = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(v).recoverPublicKey(hash).toRawBytes(false);
  return "0x" + bytesToHex(keccak_256(pub.slice(1)).slice(-20));
}

export interface SignedResponse { text: string; signature: string; signing_address?: string }

/** Verify a provider response signature: signer must be the attested address and the signed text must match our hashes. */
export function verifySignedResponse(sig: SignedResponse, attestedAddress: string, expected?: { reqSha256: string; respSha256: string }): VerifyResult {
  const checks: Check[] = [];
  let recovered = "";
  try { recovered = recoverAddress(sig.text, sig.signature); checks.push({ name: "signature recovers", ok: true }); }
  catch (e) { checks.push({ name: "signature recovers", ok: false, detail: (e as Error).message }); }
  checks.push({ name: "signer is attested enclave", ok: !!recovered && recovered.toLowerCase() === attestedAddress.toLowerCase() });
  if (expected) checks.push({ name: "signed hashes match relay hashes", ok: sig.text === `${expected.reqSha256}:${expected.respSha256}` });
  return { ok: checks.every((c) => c.ok), checks, signingAddress: recovered, chainVerified: false };
}
