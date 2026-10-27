import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";

const base64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Intel TDX DCAP quote check in the browser (docs/e2e-enclave-encryption.md §3 check 2, step N1a):
 * quote signature by the attestation key → QE report binds that key → QE report signed by the PCK
 * certificate → PCK chain up to the Intel SGX Root CA pinned below. Everything checked comes from
 * the quote and this bundle, so a dishonest relay cannot make a forged quote pass.
 *
 * Not checked here (N1b): TCB info, QE identity, CRLs, collateral freshness. Passing this alone
 * proves only that a key Intel certified for this platform signed the QE report; without the QE
 * identity check it is not yet proof that Intel's own Quoting Enclave made the quote, nor that the
 * platform is up to date or not revoked. Do not wire it into the chat before N1b.
 */

/**
 * Intel SGX Root CA (also the root for TDX), DER, from
 * https://certificates.trustedservices.intel.com/Intel_SGX_Provisioning_Certification_RootCA.pem
 * SHA-256 fingerprint 44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3 (tests pin it).
 */
export const INTEL_SGX_ROOT_CA = base64ToBytes(
  "MIICjzCCAjSgAwIBAgIUImUM1lqdNInzg7SVUr9QGzknBqwwCgYIKoZIzj0EAwIwaDEaMBgGA1UEAwwRSW50ZWwgU0dYIFJvb3QgQ0ExGjAYBgNVBAoMEUludGVsIENvcnBvcmF0aW9uMRQwEgYDVQQHDAtTYW50YSBDbGFyYTELMAkGA1UECAwCQ0ExCzAJBgNVBAYTAlVTMB4XDTE4MDUyMTEwNDUxMFoXDTQ5MTIzMTIzNTk1OVowaDEaMBgGA1UEAwwRSW50ZWwgU0dYIFJvb3QgQ0ExGjAYBgNVBAoMEUludGVsIENvcnBvcmF0aW9uMRQwEgYDVQQHDAtTYW50YSBDbGFyYTELMAkGA1UECAwCQ0ExCzAJBgNVBAYTAlVTMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEC6nEwMDIYZOj/iPWsCzaEKi71OiOSLRFhWGjbnBVJfVnkY4u3IjkDYYL0MxO4mqsyYjlBalTVYxFP2sJBK5zlKOBuzCBuDAfBgNVHSMEGDAWgBQiZQzWWp00ifODtJVSv1AbOScGrDBSBgNVHR8ESzBJMEegRaBDhkFodHRwczovL2NlcnRpZmljYXRlcy50cnVzdGVkc2VydmljZXMuaW50ZWwuY29tL0ludGVsU0dYUm9vdENBLmRlcjAdBgNVHQ4EFgQUImUM1lqdNInzg7SVUr9QGzknBqwwDgYDVR0PAQH/BAQDAgEGMBIGA1UdEwEB/wQIMAYBAf8CAQEwCgYIKoZIzj0EAwIDSQAwRgIhAOW/5QkR+S9CiSDcNoowLuPRLsWGf/Yi7GSX94BgwTwgAiEA4J0lrHoMs+Xo5o/sX6O9QWxHRAvZUGOdRQ7cvqRXaqI=",
);

/** Quote layout (Intel TDX DCAP Quote Generation Library, appendix A). */
const HEADER = 48;
const TD10_BODY = 584; // v4, and v5 body type 2
const TD15_BODY = 648; // v5 body type 3
const QE_REPORT = 384; // SGX report body; report_data at 320..384
const TEE_TDX = 0x81;
const ATT_KEY_ECDSA_P256 = 2;
const CERT_QE_REPORT = 6;
const CERT_PCK_CHAIN = 5;

export class DcapError extends Error {}

function fail(msg: string): never {
  throw new DcapError(`dcap: ${msg}`);
}

/** Bounds-checked little-endian reader; any read past the end means a truncated quote. */
function reader(b: Uint8Array) {
  let pos = 0;
  const take = (n: number) => {
    if (n < 0 || pos + n > b.length) fail("quote truncated");
    return b.subarray(pos, (pos += n));
  };
  const uint = (n: number) => take(n).reduceRight((v, x) => v * 256 + x, 0);
  return { take, u16: () => uint(2), u32: () => uint(4), get pos() { return pos; } };
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** ECDSA P-256 / SHA-256 over msg; sig is r‖s (64 bytes) or DER, key is uncompressed SEC1. */
function verifyP256(sig: Uint8Array, msg: Uint8Array, key: Uint8Array, der = false): boolean {
  try {
    return p256.verify(sig, sha256(msg), key, { format: der ? "der" : "compact" });
  } catch {
    return false;
  }
}

/**
 * Verifies `quote` (raw bytes) and throws DcapError naming the first failed check.
 * `root` and `now` are for tests; production uses the pinned Intel root and the browser clock.
 */
export function verifyTdxQuote(
  quote: Uint8Array,
  { root = INTEL_SGX_ROOT_CA, now = new Date() }: { root?: Uint8Array; now?: Date } = {},
): void {
  try {
    verify(quote, root, now);
  } catch (e) {
    if (e instanceof DcapError) throw e;
    throw new DcapError("dcap: malformed quote", { cause: e }); // e.g. a DER field missing where the parser expects one
  }
}

function verify(quote: Uint8Array, root: Uint8Array, now: Date): void {
  const r = reader(quote);
  const header = r.take(HEADER);
  const h = reader(header);
  const version = h.u16();
  if (h.u16() !== ATT_KEY_ECDSA_P256) fail("attestation key type is not ECDSA P-256");
  if (h.u32() !== TEE_TDX) fail("not a TDX quote");
  if (version === 4) r.take(TD10_BODY);
  else if (version === 5) {
    const type = r.u16();
    const size = r.u32();
    if (!((type === 2 && size === TD10_BODY) || (type === 3 && size === TD15_BODY))) fail(`unsupported v5 body type ${type}`);
    r.take(size);
  } else fail(`unsupported quote version ${version}`);
  const signed = quote.subarray(0, r.pos);

  const sigData = reader(r.take(r.u32()));
  const quoteSig = sigData.take(64);
  const attKey = sigData.take(64);
  if (sigData.u16() !== CERT_QE_REPORT) fail("certification data is not a QE report");
  const qe = reader(sigData.take(sigData.u32()));
  const qeReport = qe.take(QE_REPORT);
  const qeReportSig = qe.take(64);
  const qeAuth = qe.take(qe.u16());
  if (qe.u16() !== CERT_PCK_CHAIN) fail("QE certification data is not a PCK chain");
  const pem = qe.take(qe.u32());

  const attKeySec1 = new Uint8Array([4, ...attKey]);
  if (!verifyP256(quoteSig, signed, attKeySec1)) fail("quote signature invalid");

  const bound = qeReport.subarray(320, 384);
  if (!equal(bound.subarray(0, 32), sha256(new Uint8Array([...attKey, ...qeAuth]))) || bound.subarray(32).some((x) => x !== 0))
    fail("QE report does not bind the attestation key");

  const pck = verifyPckChain(pem, root, now);
  if (!verifyP256(qeReportSig, qeReport, pck.key)) fail("QE report signature invalid");
}

// ---- X.509, only as much as Intel's PCK chain needs ----

/** `at` is where the TLV header starts, `start` where its content starts. */
type Node = { tag: number; at: number; start: number; end: number };

/** One DER TLV at `at` inside `b`, ending no later than `limit`. */
function tlv(b: Uint8Array, at: number, limit = b.length): Node {
  if (at + 2 > limit) fail("certificate truncated");
  const tag = b[at];
  let len = b[at + 1];
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 3 || start + n > limit) fail("certificate length invalid");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[start + i];
    start += n;
  }
  if (start + len > limit) fail("certificate truncated");
  return { tag, at, start, end: start + len };
}

function children(b: Uint8Array, n: Node): Node[] {
  const out: Node[] = [];
  for (let at = n.start; at < n.end; at = out[out.length - 1].end) out.push(tlv(b, at, n.end));
  return out;
}

const bytes = (b: Uint8Array, n: Node) => b.subarray(n.start, n.end);
const whole = (b: Uint8Array, n: Node) => b.subarray(n.at, n.end);

// AlgorithmIdentifier ecdsa-with-SHA256, and SubjectPublicKeyInfo algorithm id-ecPublicKey + prime256v1.
const ECDSA_SHA256 = new Uint8Array([0x30, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]);
const EC_P256 = new Uint8Array([
  0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
]);
const BASIC_CONSTRAINTS = new Uint8Array([0x55, 0x1d, 0x13]);

type Cert = {
  tbs: Uint8Array;
  sig: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  key: Uint8Array;
  ca: boolean;
};

function time(b: Uint8Array, n: Node): number {
  const s = new TextDecoder().decode(bytes(b, n));
  const m = (n.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/ : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/).exec(s);
  if (!m || (n.tag !== 0x17 && n.tag !== 0x18)) fail("certificate time invalid");
  let y = Number(m[1]);
  if (n.tag === 0x17) y += y < 50 ? 2000 : 1900; // RFC 5280 4.1.2.5.1
  return Date.UTC(y, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function parseCert(der: Uint8Array): Cert {
  const cert = tlv(der, 0);
  if (cert.tag !== 0x30 || cert.end !== der.length) fail("certificate is not one DER SEQUENCE");
  const [tbsN, algN, sigN, ...rest] = children(der, cert);
  if (!sigN || rest.length || tbsN.tag !== 0x30 || sigN.tag !== 0x03) fail("certificate structure invalid");
  if (!equal(whole(der, algN), ECDSA_SHA256)) fail("certificate not signed with ECDSA-SHA256");
  const sigBits = bytes(der, sigN);
  if (sigBits[0] !== 0) fail("certificate signature bits invalid");

  let f = children(der, tbsN);
  if (f[0]?.tag === 0xa0) f = f.slice(1); // explicit version
  const [, tbsAlg, issuer, validity, subject, spki, ...extra] = f;
  if (!spki || !equal(whole(der, tbsAlg), ECDSA_SHA256)) fail("certificate TBS invalid");
  const [nb, na] = children(der, validity);
  const [keyAlg, keyBits] = children(der, spki);
  if (!keyBits || !equal(whole(der, keyAlg), EC_P256)) fail("certificate key is not P-256");
  const key = bytes(der, keyBits);
  if (key.length !== 66 || key[0] !== 0 || key[1] !== 4) fail("certificate key encoding invalid");

  let ca = false;
  const ext = extra.find((n) => n.tag === 0xa3);
  if (ext) {
    for (const e of children(der, children(der, ext)[0])) {
      const [oid, ...v] = children(der, e);
      if (!equal(bytes(der, oid), BASIC_CONSTRAINTS)) continue;
      const value = v[v.length - 1];
      const bc = children(der, tlv(der, value.start, value.end));
      ca = bc[0]?.tag === 0x01 && der[bc[0].start] !== 0;
    }
  }
  return {
    tbs: whole(der, tbsN),
    sig: sigBits.subarray(1),
    issuer: whole(der, issuer),
    subject: whole(der, subject),
    notBefore: time(der, nb),
    notAfter: time(der, na),
    key: key.subarray(1),
    ca,
  };
}

function pemCerts(pem: Uint8Array): Uint8Array[] {
  if (pem.length > 16384) fail("PCK chain too large"); // a real chain is ~3 KB; caps the regex scan
  const text = new TextDecoder().decode(pem);
  return [...text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map((m) =>
    base64ToBytes(m[1].replace(/\s+/g, "")),
  );
}

/**
 * PCK leaf ← PCK Platform/Processor CA ← pinned root. The quote may carry a root as the third
 * certificate; it is accepted only if byte-identical to the pinned one, so it adds no trust.
 */
function verifyPckChain(pem: Uint8Array, rootDer: Uint8Array, now: Date): Cert {
  const ders = pemCerts(pem);
  if (ders.length < 2 || ders.length > 3) fail(`PCK chain has ${ders.length} certificates`);
  if (ders[2] && !equal(ders[2], rootDer)) fail("PCK chain root is not the pinned Intel root");
  const [leaf, mid] = ders.map(parseCert);
  const root = parseCert(rootDer);
  const t = now.getTime();
  if (!Number.isFinite(t)) fail("clock invalid");
  for (const [c, issuer] of [[leaf, mid], [mid, root], [root, root]] as const) {
    if (!equal(c.issuer, issuer.subject)) fail("PCK chain names do not link");
    if (!issuer.ca) fail("PCK chain issuer is not a CA");
    if (t < c.notBefore || t > c.notAfter) fail("PCK chain certificate outside its validity");
    if (!verifyP256(c.sig, c.tbs, issuer.key, true)) fail("PCK chain signature invalid");
  }
  return leaf;
}
