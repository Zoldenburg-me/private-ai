import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";

const base64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * Intel TDX DCAP quote check in the browser (docs/e2e-enclave-encryption.md §3 checks 2 and 3, steps N1a and N1b):
 * quote signature by the attestation key → QE report binds that key → QE report signed by the PCK
 * certificate → PCK chain up to the Intel SGX Root CA pinned below; then Intel's collateral: root and
 * PCK CRLs, TCB info and QE identity, each signed under that root and inside a maximum age. The quote
 * and the collateral may come through the relay: everything is checked against the pinned root, so a
 * dishonest relay can withhold collateral or serve it up to its maximum age, but cannot make a forged,
 * revoked or out-of-date platform pass.
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

const DAY = 86_400_000;
/** TCB info, QE identity and the PCK CRL must be issued within this (Intel reissues them hourly; the relay refreshes hourly). */
export const MAX_COLLATERAL_AGE_MS = 3 * DAY;
/** How far the browser clock may run behind Intel's before collateral counts as issued in the future. */
export const CLOCK_TOLERANCE_MS = 10 * 60_000;
/** TCB statuses we accept; OutOfDate, OutOfDateConfigurationNeeded, Revoked and anything unknown fail closed. */
const TCB_OK = new Set(["UpToDate", "SWHardeningNeeded", "ConfigurationNeeded", "ConfigurationAndSWHardeningNeeded"]);

/** Intel's collateral for one quote, in dcap-qvl's QuoteCollateralV3 JSON shape (the fields checked here). */
export type Collateral = {
  root_ca_crl: string; // DER, hex
  pck_crl: string; // DER, hex
  tcb_info_issuer_chain: string; // PEM
  tcb_info: string; // JSON exactly as Intel signed it
  tcb_info_signature: string; // r‖s, hex
  qe_identity_issuer_chain: string;
  qe_identity: string;
  qe_identity_signature: string;
};
const COLLATERAL_FIELDS: (keyof Collateral)[] = [
  "root_ca_crl", "pck_crl", "tcb_info_issuer_chain", "tcb_info", "tcb_info_signature", "qe_identity_issuer_chain", "qe_identity", "qe_identity_signature",
];

export type TcbResult = { tcbStatus: string; advisoryIds: string[] };

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

/** Turns any parser slip (e.g. a field missing where the parser expects one) into a DcapError. */
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof DcapError) throw e;
    throw new DcapError("dcap: malformed quote or collateral", { cause: e });
  }
}

/**
 * Verifies `quote` (raw bytes) with Intel's `collateral` and throws DcapError naming the first failed
 * check. `root` and `now` are for tests; production uses the pinned Intel root and the browser clock.
 */
export function verifyTdxQuote(
  quote: Uint8Array,
  collateral: Collateral,
  { root = INTEL_SGX_ROOT_CA, now = new Date() }: { root?: Uint8Array; now?: Date } = {},
): TcbResult {
  return guard(() => {
    const q = parseQuote(quote);
    const chain = verifyQuote(q, root, now);
    return verifyCollateral(q, chain, collateral, now.getTime());
  });
}

/**
 * Which collateral to fetch for `quote`: its platform's FMSPC and the PCK CA that issued it. Read from the
 * quote unverified; verifyTdxQuote then checks that the collateral fits.
 */
export function collateralQuery(quote: Uint8Array): { fmspc: string; ca: "platform" | "processor" } {
  return guard(() => {
    const [leaf, mid] = pemCerts(parseQuote(quote).pem).map(parseCert);
    if (!mid) fail("PCK chain has no CA certificate");
    const name = new TextDecoder().decode(mid.subject);
    const ca = name.includes("Intel SGX PCK Platform CA") ? "platform" : name.includes("Intel SGX PCK Processor CA") ? "processor" : fail("PCK CA unknown");
    return { fmspc: toHex(pckInfo(leaf).fmspc).toUpperCase(), ca };
  });
}

type Quote = ReturnType<typeof parseQuote>;

function parseQuote(quote: Uint8Array) {
  const r = reader(quote);
  const header = r.take(HEADER);
  const h = reader(header);
  const version = h.u16();
  if (h.u16() !== ATT_KEY_ECDSA_P256) fail("attestation key type is not ECDSA P-256");
  if (h.u32() !== TEE_TDX) fail("not a TDX quote");
  let td: Uint8Array;
  if (version === 4) td = r.take(TD10_BODY);
  else if (version === 5) {
    const type = r.u16();
    const size = r.u32();
    if (!((type === 2 && size === TD10_BODY) || (type === 3 && size === TD15_BODY))) fail(`unsupported v5 body type ${type}`);
    td = r.take(size);
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
  return { td, signed, quoteSig, attKey, qeReport, qeReportSig, qeAuth, pem };
}

function verifyQuote(q: Quote, root: Uint8Array, now: Date): Chain {
  const attKeySec1 = new Uint8Array([4, ...q.attKey]);
  if (!verifyP256(q.quoteSig, q.signed, attKeySec1)) fail("quote signature invalid");

  const bound = q.qeReport.subarray(320, 384);
  if (!equal(bound.subarray(0, 32), sha256(new Uint8Array([...q.attKey, ...q.qeAuth]))) || bound.subarray(32).some((x) => x !== 0))
    fail("QE report does not bind the attestation key");

  const chain = verifyPckChain(q.pem, root, now);
  if (!verifyP256(q.qeReportSig, q.qeReport, chain.leaf.key)) fail("QE report signature invalid");
  return chain;
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
const SGX_EXT = "2a864886f84d010d01"; // 1.2.840.113741.1.13.1

type Cert = {
  tbs: Uint8Array;
  serial: Uint8Array;
  sig: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  key: Uint8Array;
  ca: boolean;
  sgx?: Uint8Array; // Intel SGX extension (PCK certificates), DER
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
  const [serial, tbsAlg, issuer, validity, subject, spki, ...extra] = f;
  if (!spki || !equal(whole(der, tbsAlg), ECDSA_SHA256)) fail("certificate TBS invalid");
  const [nb, na] = children(der, validity);
  const [keyAlg, keyBits] = children(der, spki);
  if (!keyBits || !equal(whole(der, keyAlg), EC_P256)) fail("certificate key is not P-256");
  const key = bytes(der, keyBits);
  if (key.length !== 66 || key[0] !== 0 || key[1] !== 4) fail("certificate key encoding invalid");

  let ca = false;
  let sgx: Uint8Array | undefined;
  const ext = extra.find((n) => n.tag === 0xa3);
  if (ext) {
    for (const e of children(der, children(der, ext)[0])) {
      const [oid, ...v] = children(der, e);
      const value = v[v.length - 1];
      if (toHex(bytes(der, oid)) === SGX_EXT) sgx = bytes(der, value);
      if (!equal(bytes(der, oid), BASIC_CONSTRAINTS)) continue;
      const bc = children(der, tlv(der, value.start, value.end));
      ca = bc[0]?.tag === 0x01 && der[bc[0].start] !== 0;
    }
  }
  return {
    tbs: whole(der, tbsN),
    serial: bytes(der, serial),
    sig: sigBits.subarray(1),
    issuer: whole(der, issuer),
    subject: whole(der, subject),
    notBefore: time(der, nb),
    notAfter: time(der, na),
    key: key.subarray(1),
    ca,
    sgx,
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
type Chain = { leaf: Cert; mid: Cert; root: Cert };

function verifyPckChain(pem: Uint8Array, rootDer: Uint8Array, now: Date): Chain {
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
  return { leaf, mid, root };
}

// ---- Intel collateral (N1b) ----

function fromHex(s: unknown, what: string): Uint8Array {
  if (typeof s !== "string" || !/^(?:[0-9a-fA-F]{2})*$/.test(s)) fail(`${what} is not hex`);
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}

/** The PCK certificate's platform fields (Intel SGX PCK Certificate and CRL Profile, 1.3.5). */
function pckInfo(leaf: Cert) {
  const b = leaf.sgx ?? fail("PCK certificate has no Intel SGX extension");
  const fields = new Map<string, Uint8Array>();
  const walk = (n: Node) => {
    for (const e of children(b, n)) {
      const [oid, value] = children(b, e);
      const k = toHex(bytes(b, oid));
      if (k === `${SGX_EXT}02`) walk(value); // TCB: component SVNs, PCESVN, CPUSVN
      else fields.set(k, bytes(b, value));
    }
  };
  walk(tlv(b, 0));
  const get = (sub: string, n?: number) => {
    const v = fields.get(SGX_EXT + sub);
    if (!v || (n !== undefined && v.length !== n)) fail("PCK certificate SGX extension invalid");
    return v;
  };
  return { cpuSvn: get("0212", 16), pceSvn: get("0211").reduce((v, x) => v * 256 + x, 0), pceId: get("03", 2), fmspc: get("04", 6) };
}

type Crl = { tbs: Uint8Array; sig: Uint8Array; issuer: Uint8Array; thisUpdate: number; nextUpdate: number; revoked: Uint8Array[] };

function parseCrl(der: Uint8Array): Crl {
  const crl = tlv(der, 0);
  if (crl.tag !== 0x30 || crl.end !== der.length) fail("CRL is not one DER SEQUENCE");
  const [tbsN, algN, sigN, ...rest] = children(der, crl);
  if (!sigN || rest.length || tbsN.tag !== 0x30 || sigN.tag !== 0x03 || !equal(whole(der, algN), ECDSA_SHA256)) fail("CRL structure invalid");
  const sigBits = bytes(der, sigN);
  if (sigBits[0] !== 0) fail("CRL signature bits invalid");
  let f = children(der, tbsN);
  if (f[0]?.tag === 0x02) f = f.slice(1); // version
  const [alg, issuer, thisU, nextU, list] = f;
  if (!nextU || nextU.tag === 0x30 || !equal(whole(der, alg), ECDSA_SHA256)) fail("CRL TBS invalid");
  return {
    tbs: whole(der, tbsN),
    sig: sigBits.subarray(1),
    issuer: whole(der, issuer),
    thisUpdate: time(der, thisU),
    nextUpdate: time(der, nextU),
    revoked: list?.tag === 0x30 ? children(der, list).map((e) => bytes(der, children(der, e)[0])) : [],
  };
}

/** Issued no later than the clock allows, not past its next update and, with `maxAge`, issued recently enough. */
function fresh(what: string, issued: number, next: number, t: number, maxAge?: number): void {
  if (!Number.isFinite(issued) || !Number.isFinite(next)) fail(`${what} dates invalid`);
  if (issued > t + CLOCK_TOLERANCE_MS) fail(`${what} issued in the future: the device clock is wrong`);
  if (t > next + CLOCK_TOLERANCE_MS) fail(`${what} expired`);
  if (maxAge !== undefined && t - issued > maxAge) fail(`${what} too old`);
}

function isoTime(s: unknown): number {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s) ? Date.parse(s) : NaN;
}

/** Revoked serials, after checking the CRL was signed by `issuer` and is current. */
function checkCrl(hexDer: string, what: string, issuer: Cert, t: number, maxAge?: number): Uint8Array[] {
  const crl = parseCrl(fromHex(hexDer, what));
  if (!equal(crl.issuer, issuer.subject)) fail(`${what} is from another issuer`);
  if (!verifyP256(crl.sig, crl.tbs, issuer.key, true)) fail(`${what} signature invalid`);
  fresh(what, crl.thisUpdate, crl.nextUpdate, t, maxAge);
  return crl.revoked;
}

const revoked = (list: Uint8Array[], c: Cert) => list.some((s) => equal(s, c.serial));

/** The JSON Intel signed with the first certificate of `pem`, which must come straight from the root. */
function signedJson(json: string, sigHex: string, pem: string, what: string, root: Cert, rootRevoked: Uint8Array[], t: number) {
  const [der] = pemCerts(utf8(pem));
  if (!der) fail(`${what} signing certificate missing`);
  const signer = parseCert(der);
  if (!equal(signer.issuer, root.subject) || !verifyP256(signer.sig, signer.tbs, root.key, true))
    fail(`${what} signing certificate is not from the Intel root`);
  if (signer.ca) fail(`${what} signing certificate is a CA`);
  if (t < signer.notBefore || t > signer.notAfter) fail(`${what} signing certificate outside its validity`);
  if (revoked(rootRevoked, signer)) fail(`${what} signing certificate revoked`);
  const sig = fromHex(sigHex, `${what} signature`);
  if (sig.length !== 64 || !verifyP256(sig, utf8(json), signer.key)) fail(`${what} signature invalid`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Intel-signed JSON; every field read is checked below
  let body: any;
  try {
    body = JSON.parse(json);
  } catch {
    fail(`${what} is not JSON`);
  }
  fresh(what, isoTime(body?.issueDate), isoTime(body?.nextUpdate), t, MAX_COLLATERAL_AGE_MS);
  return body;
}

/** The first TCB level `meets` accepts, its status checked; Intel lists levels from newest to oldest. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- levels from Intel-signed JSON
function tcbLevel(levels: any, meets: (l: any) => boolean, where: string): { status: string; advisories: string[] } {
  const l = Array.isArray(levels) ? levels.find(meets) : undefined;
  if (!l) fail(`TCB below every level Intel lists (${where})`);
  const s = l.tcbStatus;
  if (s === "Revoked") fail(`TCB revoked (${where})`);
  if (s === "OutOfDate" || s === "OutOfDateConfigurationNeeded") fail(`TCB out of date (${where})`);
  if (!TCB_OK.has(s)) fail(`TCB status unknown (${where})`);
  return { status: s, advisories: Array.isArray(l.advisoryIDs) ? l.advisoryIDs.filter((a: unknown) => typeof a === "string") : [] };
}

/** `have[i] >= svn of comps[i]` for every i from `skip`; the lists must be equally long. */
function meetsSvns(have: Uint8Array, comps: unknown, skip = 0): boolean {
  if (!Array.isArray(comps) || comps.length !== have.length) fail("TCB info level malformed");
  return comps.every((c, i) => i < skip || have[i] >= c?.svn);
}

/** Masked bytes equal Intel's expected value; with `strict`, bits outside the mask must be zero too. */
function masked(v: Uint8Array, expect: unknown, mask: unknown, what: string, strict = false): void {
  const e = fromHex(expect, what);
  const m = fromHex(mask, what);
  if (e.length !== v.length || m.length !== v.length || v.some((x, i) => (x & m[i]) !== (e[i] & m[i]) || (strict && x & ~m[i])))
    fail(`${what} does not match Intel's identity`);
}

const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);

/**
 * §3 check 3: CRLs (root CA, PCK CA), the QE identity (the QE report must come from Intel's TD QE) and the TCB
 * info for this platform (FMSPC), each Intel-signed and fresh; then the platform, TDX module and QE TCB levels.
 * Follows dcap-qvl's verify_impl, except that OutOfDate components fail here instead of lowering the status.
 */
function verifyCollateral(q: Quote, chain: Chain, c: Collateral, t: number): TcbResult {
  if (!c || COLLATERAL_FIELDS.some((k) => typeof c[k] !== "string" || !c[k])) fail("collateral missing");
  const { leaf, mid, root } = chain;
  // No maximum age for the root CA CRL: Intel issues it yearly. It only lists revoked Intel CAs and signing certificates.
  const rootRevoked = checkCrl(c.root_ca_crl, "root CA CRL", root, t);
  if (revoked(rootRevoked, mid)) fail("PCK CA certificate revoked");
  if (revoked(checkCrl(c.pck_crl, "PCK CRL", mid, t, MAX_COLLATERAL_AGE_MS), leaf)) fail("PCK certificate revoked");

  const qeId = signedJson(c.qe_identity, c.qe_identity_signature, c.qe_identity_issuer_chain, "QE identity", root, rootRevoked, t);
  if (qeId.id !== "TD_QE" || (qeId.version !== 2 && qeId.version !== 3)) fail("QE identity is not for the TDX QE");
  const r = q.qeReport;
  if (!equal(r.subarray(128, 160), fromHex(qeId.mrsigner, "QE identity MRSIGNER"))) fail("QE report is not from Intel's QE (MRSIGNER)");
  if (u16le(r, 256) !== qeId.isvprodid) fail("QE report is not from Intel's QE (ISVPRODID)");
  masked(r.subarray(16, 20), qeId.miscselect, qeId.miscselectMask, "QE MISCSELECT");
  masked(r.subarray(48, 64), qeId.attributes, qeId.attributesMask, "QE attributes");
  const qeTcb = tcbLevel(qeId.tcbLevels, (l) => u16le(r, 258) >= l?.tcb?.isvsvn, "QE");

  const tcb = signedJson(c.tcb_info, c.tcb_info_signature, c.tcb_info_issuer_chain, "TCB info", root, rootRevoked, t);
  if (tcb.id !== "TDX" || tcb.version !== 3) fail("TCB info is not TDX TCB info v3");
  const pck = pckInfo(leaf);
  if (!equal(fromHex(tcb.fmspc, "FMSPC"), pck.fmspc) || !equal(fromHex(tcb.pceId, "PCE-ID"), pck.pceId)) fail("TCB info is for another platform (FMSPC)");

  // The TDX module identity for a TEE_TCB_SVN: version tee_tcb_svn[1], or the base module for version 0.
  const moduleOf = (svn: Uint8Array) => {
    if (svn[1] === 0) return tcb.tdxModule ?? fail("TCB info has no TDX module");
    const id = `TDX_${svn[1].toString(16).padStart(2, "0").toUpperCase()}`;
    return (Array.isArray(tcb.tdxModuleIdentities) && tcb.tdxModuleIdentities.find((m: { id?: unknown }) => String(m?.id).toUpperCase() === id)) || fail(`TCB info has no TDX module ${id}`);
  };
  // A TD 1.5 body also carries the current TCB (TEE_TCB_SVN2, at 584); like dcap-qvl it must pass too.
  const svns = q.td.length === TD15_BODY ? [q.td.subarray(0, 16), q.td.subarray(584, 600)] : [q.td.subarray(0, 16)];
  const levels = svns.flatMap((svn) => [
    tcbLevel(tcb.tcbLevels, (l) => pck.pceSvn >= l?.tcb?.pcesvn && meetsSvns(pck.cpuSvn, l?.tcb?.sgxtcbcomponents) && meetsSvns(svn, l?.tcb?.tdxtcbcomponents, svn[1] > 0 ? 2 : 0), "platform"),
    ...(svn[1] > 0 ? [tcbLevel(moduleOf(svn).tcbLevels, (l) => svn[0] >= l?.tcb?.isvsvn, "TDX module")] : []),
  ]);
  levels.push(qeTcb);
  const mod = moduleOf(q.td.subarray(0, 16));
  if (!equal(q.td.subarray(64, 112), fromHex(mod.mrsigner, "TDX module MRSIGNER"))) fail("TDX module signer does not match Intel's TCB info");
  masked(q.td.subarray(112, 120), mod.attributes, mod.attributesMask, "TDX module attributes", true);

  // The worst accepted status over every level (platform, TDX module, QE; launch and current TCB).
  const needs = (w: string) => levels.some((l) => l.status.includes(w));
  const tcbStatus = needs("Configuration") ? (needs("SWHardening") ? "ConfigurationAndSWHardeningNeeded" : "ConfigurationNeeded") : needs("SWHardening") ? "SWHardeningNeeded" : "UpToDate";
  return { tcbStatus, advisoryIds: [...new Set(levels.flatMap((l) => l.advisories))] };
}
