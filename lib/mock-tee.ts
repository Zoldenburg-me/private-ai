import { ed25519 } from "@noble/curves/ed25519";
import { p256 } from "@noble/curves/nist";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from "@noble/hashes/utils";
import { TDX } from "./attestation";

/** TEST/DEV ONLY mock enclave. Fixed throwaway key; never used with real providers. */
const MOCK_PRIV = hexToBytes("4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318");

export function mockAddress(): string {
  return "0x" + bytesToHex(keccak_256(secp256k1.getPublicKey(MOCK_PRIV, false).slice(1)).slice(-20));
}

export function mockQuote(nonceHex: string, opts: { debug?: boolean; address?: string } = {}): string {
  const q = new Uint8Array(TDX.MIN_LEN);
  q[0] = 4;
  if (opts.debug) q[TDX.TD_ATTRIBUTES] = 1;
  const addr = hexToBytes((opts.address ?? mockAddress()).replace(/^0x/, ""));
  q.set(concatBytes(addr, new Uint8Array(12), hexToBytes(nonceHex)), TDX.REPORT_DATA);
  return bytesToHex(q);
}

export function mockReport(nonceHex: string, opts: { debug?: boolean } = {}) {
  return {
    signing_address: mockAddress(), signing_algo: "ecdsa", request_nonce: nonceHex,
    intel_quote: mockQuote(nonceHex, opts), nvidia_payload: JSON.stringify({ nonce: nonceHex, arch: "MOCK" }),
  };
}

export function mockSign(text: string): string {
  const msg = utf8ToBytes(text);
  const hash = keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), msg));
  const s = secp256k1.sign(hash, MOCK_PRIV);
  return "0x" + bytesToHex(s.toCompactRawBytes()) + (27 + s.recovery).toString(16);
}

// ---- E2EE (docs/e2e-enclave-encryption.md N2b): an Ed25519 enclave key and a DCAP-shaped quote ----
// Every key below is derived from this label, so scripts/check-test-root.mjs can find it in a bundle.
const TEST_KEY_LABEL = "pai-mock-tee/";
const testKey = (name: string) => sha256(utf8ToBytes(TEST_KEY_LABEL + name));

/** Seed of the mock enclave's Ed25519 key (NEAR's `signing_public_key`, also its E2EE key). */
export const MOCK_ED25519_SEED = testKey("ed25519");
export const mockEd25519Pub = () => bytesToHex(ed25519.getPublicKey(MOCK_ED25519_SEED));

// A tiny DER builder: just enough X.509 for lib/client/e2e/dcap.ts to walk a PCK-shaped chain.
const der = (tag: number, ...parts: Uint8Array[]) => {
  const body = concatBytes(...parts);
  const n = body.length;
  return concatBytes(new Uint8Array([tag, ...(n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255])]), body);
};
const ECDSA_SHA256 = hexToBytes("300a06082a8648ce3d040302");
const cn = (s: string) => der(0x30, der(0x31, der(0x30, hexToBytes("0603550403"), der(0x0c, utf8ToBytes(s)))));
function cert(subject: string, issuer: string, key: Uint8Array, signer: Uint8Array, ca: boolean): Uint8Array {
  const tbs = der(0x30,
    der(0xa0, hexToBytes("020102")), hexToBytes("020101"), ECDSA_SHA256, cn(issuer),
    der(0x30, der(0x17, utf8ToBytes("200101000000Z")), der(0x17, utf8ToBytes("491231235959Z"))), cn(subject),
    der(0x30, hexToBytes("301306072a8648ce3d020106082a8648ce3d030107"), der(0x03, new Uint8Array([0]), p256.getPublicKey(key, false))),
    der(0xa3, der(0x30, der(0x30, hexToBytes("0603551d13"), hexToBytes("0101ff"), der(0x04, der(0x30, ...(ca ? [hexToBytes("0101ff")] : [])))))));
  return der(0x30, tbs, ECDSA_SHA256, der(0x03, new Uint8Array([0]), p256.sign(sha256(tbs), signer).toDERRawBytes()));
}
const [ROOT_KEY, CA_KEY, PCK_KEY, ATT_KEY] = ["root", "ca", "pck", "attestation"].map(testKey);

/**
 * TEST-ONLY trust root: stands in for the Intel SGX Root CA when tests verify a mock quote with
 * `verifyTdxQuote(quote, { root: MOCK_ROOT_CA })`. It must never reach the browser bundle
 * (`npm run build` fails if it does), or a mock enclave could pass the client's checks.
 */
export const MOCK_ROOT_CA = cert("Mock TEE Test Root CA", "Mock TEE Test Root CA", ROOT_KEY, ROOT_KEY, true);
const PCK_PEM = utf8ToBytes([cert("Mock PCK", "Mock PCK CA", PCK_KEY, CA_KEY, false), cert("Mock PCK CA", "Mock TEE Test Root CA", CA_KEY, ROOT_KEY, true)]
  .map((d) => `-----BEGIN CERTIFICATE-----\n${btoa(String.fromCharCode(...d))}\n-----END CERTIFICATE-----\n`).join(""));

const le = (v: number, n: number) => Uint8Array.from({ length: n }, (_, i) => (v / 256 ** i) & 255);

/** A v4 TDX quote, signed through the test root, whose report_data is `reportData` (64 bytes). */
export function mockDcapQuote(reportData: Uint8Array, opts: { debug?: boolean } = {}): Uint8Array {
  const signed = new Uint8Array(TDX.MIN_LEN);
  signed.set([...le(4, 2), ...le(2, 2), ...le(0x81, 4)]); // version 4, ECDSA P-256 attestation key, TDX
  if (opts.debug) signed[TDX.TD_ATTRIBUTES] = 1;
  signed.set(reportData, TDX.REPORT_DATA);
  const attKey = p256.getPublicKey(ATT_KEY, false).subarray(1);
  const qeReport = new Uint8Array(384);
  qeReport.set(sha256(attKey), 320); // binds the attestation key (empty QE auth data)
  const qe = concatBytes(qeReport, p256.sign(sha256(qeReport), PCK_KEY).toCompactRawBytes(), le(0, 2), le(5, 2), le(PCK_PEM.length, 4), PCK_PEM);
  const sig = concatBytes(p256.sign(sha256(signed), ATT_KEY).toCompactRawBytes(), attKey, le(6, 2), le(qe.length, 4), qe);
  return concatBytes(signed, le(sig.length, 4), sig);
}

/** NEAR's Ed25519 model attestation: report_data = signing_public_key ‖ nonce. */
export function mockEd25519Report(nonceHex: string, opts: { debug?: boolean } = {}) {
  const pub = mockEd25519Pub();
  return {
    signing_public_key: pub, signing_algo: "ed25519", request_nonce: nonceHex,
    intel_quote: bytesToHex(mockDcapQuote(hexToBytes(pub + nonceHex), opts)), nvidia_payload: JSON.stringify({ nonce: nonceHex, arch: "MOCK" }),
  };
}
