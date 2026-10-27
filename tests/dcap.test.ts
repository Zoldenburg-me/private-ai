import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  verifyTdxQuote, collateralQuery, INTEL_SGX_ROOT_CA, DcapError, MAX_COLLATERAL_AGE_MS, CLOCK_TOLERANCE_MS, type Collateral,
} from "../lib/client/e2e/dcap";

// Official sample quotes and their collateral from Phala-Network/dcap-qvl (MIT): sample/tdx_quote and
// sample/tdx_quote_outdated, with the matching *_collateral.json (only the fields we check).
const fixture = (name: string) => hexToBytes(readFileSync(`tests/fixtures/dcap/${name}`, "utf8").trim());
const V4 = fixture("tdx-quote-v4.hex");
const V5 = fixture("tdx-quote-v5.hex"); // v5, TD 1.5 body
const collateral = (name: string): Collateral => JSON.parse(readFileSync(`tests/fixtures/dcap/${name}`, "utf8"));
const C4 = collateral("tdx-quote-v4-collateral.json");
const C5 = collateral("tdx-quote-v5-collateral.json");
const NOW = new Date("2025-06-20T00:00:00Z"); // a day after the v4 collateral was issued
const NOW5 = new Date("2026-02-19T00:00:00Z"); // a day after the v5 collateral was issued

type Opts = NonNullable<Parameters<typeof verifyTdxQuote>[2]> & { collateral?: Collateral };
const check = (q: Uint8Array, { collateral: c = C4, ...opts }: Opts = {}) => () => verifyTdxQuote(q, c, { now: NOW, ...opts });
const flip = (q: Uint8Array, at: number) => {
  const c = q.slice();
  c[at] ^= 1;
  return c;
};
const u32 = (q: Uint8Array, at: number) => q[at] | (q[at + 1] << 8) | (q[at + 2] << 16) | (q[at + 3] << 24);
// v4 offsets: header 48 + body 584, then signature length (4), quote sig (64), attestation key (64),
// cert type (2), cert size (4), QE report (384), QE report sig (64).
const SIG = 48 + 584 + 4;
const QE_REPORT = SIG + 64 + 64 + 6;
const pemStart = (q: Uint8Array) => new TextDecoder("latin1").decode(q).indexOf("-----BEGIN CERTIFICATE-----");
const pemOf = (q: Uint8Array) => q.subarray(pemStart(q), pemStart(q) + u32(q, pemStart(q) - 4));
/** Replaces the v4 quote's PCK chain and fixes the three enclosing length fields. */
function withPem(q: Uint8Array, pem: Uint8Array): Uint8Array {
  const at = pemStart(q);
  const delta = pem.length - u32(q, at - 4);
  const out = new Uint8Array([...q.subarray(0, at), ...pem, ...q.subarray(at + u32(q, at - 4))]);
  for (const f of [48 + 584, SIG + 128 + 2, at - 4]) {
    const v = u32(out, f) + delta;
    out.set([v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24], f);
  }
  return out;
}

/** A self-signed P-256 "Intel SGX Root CA" lookalike: same DER, our own key and signature. */
function fakeRoot(): Uint8Array {
  const der = INTEL_SGX_ROOT_CA.slice();
  const keyAt = bytesToHex(der).indexOf("034200" + "04") / 2 + 4;
  const sk = p256.utils.randomPrivateKey();
  der.set(p256.getPublicKey(sk, false).subarray(1), keyAt);
  return der;
}

// ---- a tiny DER builder for a fake PKI, so name and CA checks can be hit with valid signatures ----
const len = (n: number) => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]);
const tlv = (tag: number, ...parts: Uint8Array[]) => {
  const body = new Uint8Array(parts.flatMap((p) => [...p]));
  return new Uint8Array([tag, ...len(body.length), ...body]);
};
const seq = (...p: Uint8Array[]) => tlv(0x30, ...p);
const hex = (h: string) => hexToBytes(h);
const name = (cn: string) => seq(tlv(0x31, seq(hex("0603550403"), tlv(0x0c, new TextEncoder().encode(cn)))));
const ALG = hex("300a06082a8648ce3d040302");
type Key = { sk: Uint8Array; pub: Uint8Array };
const newKey = (): Key => {
  const sk = p256.utils.randomPrivateKey();
  return { sk, pub: p256.getPublicKey(sk, false) };
};
function makeCert(subject: string, issuer: string, key: Key, signer: Key, ca: boolean): Uint8Array {
  const tbs = seq(
    tlv(0xa0, hex("020102")),
    hex("020101"),
    ALG,
    name(issuer),
    seq(tlv(0x17, new TextEncoder().encode("200101000000Z")), tlv(0x17, new TextEncoder().encode("300101000000Z"))),
    name(subject),
    seq(hex("301306072a8648ce3d020106082a8648ce3d030107"), tlv(0x03, new Uint8Array([0, ...key.pub]))),
    tlv(0xa3, seq(seq(hex("0603551d13"), hex("0101ff"), tlv(0x04, seq(...(ca ? [hex("0101ff")] : [])))))),
  );
  const sig = p256.sign(sha256(tbs), signer.sk).toDERRawBytes();
  return seq(tbs, ALG, tlv(0x03, new Uint8Array([0, ...sig])));
}
const pemOfCerts = (...ders: Uint8Array[]) =>
  new TextEncoder().encode(ders.map((d) => `-----BEGIN CERTIFICATE-----\n${btoa(String.fromCharCode(...d))}\n-----END CERTIFICATE-----\n`).join(""));
/** V4 with a fake chain whose leaf really signs the QE report, checked against the fake root. */
function fakeChain(opts: { midCa?: boolean; midIssuer?: string } = {}) {
  const [rk, mk, lk] = [newKey(), newKey(), newKey()];
  const root = makeCert("Root", "Root", rk, rk, true);
  const mid = makeCert("Mid", opts.midIssuer ?? "Root", mk, rk, opts.midCa ?? true);
  const leaf = makeCert("Leaf", "Mid", lk, mk, false);
  const q = withPem(V4, pemOfCerts(leaf, mid));
  q.set(p256.sign(sha256(q.subarray(QE_REPORT, QE_REPORT + 384)), lk.sk).toCompactRawBytes(), QE_REPORT + 384);
  return check(q, { root });
}

describe("Intel TDX DCAP quote and PCK chain (N1a)", () => {
  it("pins the published Intel SGX Root CA", () => {
    expect(bytesToHex(sha256(INTEL_SGX_ROOT_CA))).toBe("44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3");
  });

  it("accepts a genuine v4 quote and checks a genuine v5 quote up to its TCB status", () => {
    expect(check(V4)).not.toThrow();
    // dcap-qvl's "outdated" sample: chain and collateral are genuine, its CPUSVN is below every level Intel lists.
    expect(check(V5, { collateral: C5, now: NOW5 })).toThrow("TCB below every level Intel lists (platform)");
  });

  it("rejects a quote whose signed body was changed (forged report_data)", () => {
    expect(check(flip(V4, 48 + 520))).toThrow("quote signature invalid");
    expect(check(flip(V5, 48 + 6 + 520))).toThrow("quote signature invalid");
  });

  it("rejects a tampered quote signature", () => {
    expect(check(flip(V4, SIG + 10))).toThrow("quote signature invalid");
  });

  it("rejects a swapped attestation key the QE report does not bind", () => {
    // Re-sign the quote with our own key so only the QE binding can catch it.
    const q = V4.slice();
    const sk = p256.utils.randomPrivateKey();
    q.set(p256.getPublicKey(sk, false).subarray(1), SIG + 64);
    q.set(p256.sign(sha256(q.subarray(0, 48 + 584)), sk).toCompactRawBytes(), SIG);
    expect(check(q)).toThrow("QE report does not bind the attestation key");
  });

  it("rejects a tampered QE report signature", () => {
    expect(check(flip(V4, QE_REPORT + 384 + 5))).toThrow("QE report signature invalid");
  });

  it("rejects a quote checked against a different root", () => {
    expect(check(V4, { root: fakeRoot() })).toThrow("PCK chain root is not the pinned Intel root");
    expect(check(V5, { root: fakeRoot() })).toThrow("PCK chain root is not the pinned Intel root");
  });

  it("rejects a two-certificate chain that reaches a lookalike root", () => {
    // Without a root in the quote, only the signature on the Platform CA ties the chain to Intel.
    const pem = new TextDecoder().decode(pemOf(V4));
    const two = withPem(V4, new TextEncoder().encode(pem.slice(0, pem.lastIndexOf("-----BEGIN CERTIFICATE-----"))));
    expect(check(two)).not.toThrow();
    expect(check(two, { root: fakeRoot() })).toThrow("PCK chain signature invalid");
  });

  it("rejects a chain that carries a root other than the pinned one", () => {
    const pem = new TextDecoder().decode(pemOf(V4));
    const cut = pem.lastIndexOf("-----BEGIN CERTIFICATE-----");
    const b64 = btoa(String.fromCharCode(...fakeRoot()));
    const three = withPem(V4, new TextEncoder().encode(`${pem.slice(0, cut)}-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`));
    expect(check(three)).toThrow("PCK chain root is not the pinned Intel root");
  });

  it("checks names and CA flags along the chain, not only signatures", () => {
    // The builder makes a chain the verifier accepts: it stops only at the genuine collateral, signed under Intel's root.
    expect(fakeChain()).toThrow("root CA CRL is from another issuer");
    expect(fakeChain({ midCa: false })).toThrow("PCK chain issuer is not a CA");
    expect(fakeChain({ midIssuer: "Other" })).toThrow("PCK chain names do not link");
  });

  it("rejects a tampered PCK certificate", () => {
    const at = pemStart(V4) + 200; // inside the leaf's base64
    const q = V4.slice();
    q[at] = q[at] === 0x41 ? 0x42 : 0x41;
    expect(check(q)).toThrow(/dcap: (PCK chain|certificate)/);
  });

  it("reports malformed certificates as DcapError", () => {
    // Empty validity: the parser trips over a missing field (a TypeError inside), which must surface as DcapError.
    const spki = seq(hex("301306072a8648ce3d020106082a8648ce3d030107"), tlv(0x03, new Uint8Array([0, 4, ...new Uint8Array(64)])));
    const bad = seq(seq(hex("020101"), ALG, name("A"), seq(), name("A"), spki), ALG, tlv(0x03, hex("00")));
    expect(check(withPem(V4, pemOfCerts(bad, bad)))).toThrow(DcapError);
  });

  it("rejects truncated quotes", () => {
    for (const n of [0, 47, 48 + 584, SIG + 100, V4.length - 200]) expect(check(V4.subarray(0, n))).toThrow("dcap:");
  });

  it("rejects certificates outside their validity", () => {
    expect(check(V4, { now: new Date("2040-01-01T00:00:00Z") })).toThrow("outside its validity");
    expect(check(V4, { now: new Date("2017-01-01T00:00:00Z") })).toThrow("outside its validity");
  });

  it("fails closed on an invalid clock and an oversized chain", () => {
    expect(check(V4, { now: new Date(NaN) })).toThrow("clock invalid");
    expect(check(withPem(V4, new Uint8Array(20000).fill(0x41)))).toThrow("PCK chain too large");
  });

  it("rejects a quote that is not TDX", () => {
    expect(check(flip(V4, 4))).toThrow("not a TDX quote");
  });
});

// ---- a "fake Intel": the genuine certificates and collateral re-signed with our own keys, so tests can
// sign revoked, out-of-date or old collateral that the verifier then checks against the fake root ----
const node = (b: Uint8Array, at: number) => {
  let n = b[at + 1];
  let start = at + 2;
  if (n & 0x80) {
    const k = n & 0x7f;
    n = 0;
    for (let i = 0; i < k; i++) n = n * 256 + b[start + i];
    start += k;
  }
  return { at, start, end: start + n };
};
const kids = (b: Uint8Array, n: ReturnType<typeof node>) => {
  const out: ReturnType<typeof node>[] = [];
  for (let at = n.start; at < n.end; at = out[out.length - 1].end) out.push(node(b, at));
  return out;
};
/** TBS fields: [version, serial, alg, issuer, validity, subject, spki, extensions]. */
const tbsFields = (der: Uint8Array) => {
  const tbs = kids(der, node(der, 0))[0];
  return { tbs, f: kids(der, tbs) };
};
const serialOf = (der: Uint8Array) => {
  const s = tbsFields(der).f[1];
  return der.slice(s.start, s.end);
};
const subjectOf = (der: Uint8Array) => {
  const s = tbsFields(der).f[5];
  return der.slice(s.at, s.end);
};
/** The same certificate with `key` as its key, signed by `signer`. */
function resign(der: Uint8Array, key: Key, signer: Key): Uint8Array {
  const { tbs: t, f } = tbsFields(der);
  const tbs = der.slice(t.at, t.end);
  const bits = kids(der, f[6])[1];
  tbs.set(key.pub.subarray(1), bits.start + 2 - t.at); // BIT STRING: unused-bits byte, 0x04, X‖Y
  return seq(tbs, ALG, tlv(0x03, new Uint8Array([0, ...p256.sign(sha256(tbs), signer.sk).toDERRawBytes()])));
}
const certsOf = (pem: string) => [...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END/g)].map((m) => Uint8Array.from(atob(m[1].replace(/\s+/g, "")), (c) => c.charCodeAt(0)));
const utc = (t: number) => new Date(t).toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z";
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
const H = 3_600_000;
const DAY = 24 * H;

function fakeIntel() {
  const [rk, mk, lk, tk] = [newKey(), newKey(), newKey(), newKey()];
  const [leafD, midD] = certsOf(new TextDecoder().decode(pemOf(V4)));
  const root = resign(INTEL_SGX_ROOT_CA, rk, rk);
  const mid = resign(midD, mk, rk);
  const leaf = resign(leafD, lk, mk);
  const signer = resign(certsOf(C4.tcb_info_issuer_chain)[0], tk, rk);
  const quote = withPem(V4, pemOfCerts(leaf, mid, root));
  quote.set(p256.sign(sha256(quote.subarray(QE_REPORT, QE_REPORT + 384)), lk.sk).toCompactRawBytes(), QE_REPORT + 384);
  const crl = (issuer: Uint8Array, key: Key, revoked: Uint8Array[], issued: number, next: number) => {
    const t = (x: number) => tlv(0x17, new TextEncoder().encode(utc(x)));
    const list = revoked.length ? [seq(...revoked.map((s) => seq(tlv(0x02, s), t(issued))))] : [];
    const tbs = seq(hex("020101"), ALG, subjectOf(issuer), t(issued), t(next), ...list);
    return bytesToHex(seq(tbs, ALG, tlv(0x03, new Uint8Array([0, ...p256.sign(sha256(tbs), key.sk).toDERRawBytes()]))));
  };
  const sign = (s: string) => bytesToHex(p256.sign(sha256(new TextEncoder().encode(s)), tk.sk).toCompactRawBytes());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Json = any;
  type Over = { tcb?: (j: Json) => void; qe?: (j: Json) => void; pckRevoked?: Uint8Array[]; rootRevoked?: Uint8Array[]; issued?: number; crlIssued?: number; next?: number; crlNext?: number };
  /** Collateral issued an hour before NOW (unless overridden), valid 30 days, nothing revoked. */
  const make = ({ tcb, qe, pckRevoked = [], rootRevoked = [], issued = NOW.getTime() - H, crlIssued = issued, next = issued + 30 * DAY, crlNext = next }: Over = {}): Collateral => {
    const dated = (json: string, edit?: (j: Json) => void) => {
      const j = { ...JSON.parse(json), issueDate: iso(issued), nextUpdate: iso(next) };
      edit?.(j);
      return JSON.stringify(j);
    };
    const tcbInfo = dated(C4.tcb_info, tcb);
    const qeId = dated(C4.qe_identity, qe);
    const chain = new TextDecoder().decode(pemOfCerts(signer, root));
    return {
      root_ca_crl: crl(root, rk, rootRevoked, crlIssued, crlNext),
      pck_crl: crl(mid, mk, pckRevoked, crlIssued, crlNext),
      tcb_info_issuer_chain: chain,
      tcb_info: tcbInfo,
      tcb_info_signature: sign(tcbInfo),
      qe_identity_issuer_chain: chain,
      qe_identity: qeId,
      qe_identity_signature: sign(qeId),
    };
  };
  const run = (c: Collateral, now = NOW, q = quote) => () => verifyTdxQuote(q, c, { root, now });
  /**
   * The fake-signed v4 quote as a v5 quote with a TD 1.5 body whose current TCB is `svn2`: new attestation key,
   * so the quote is re-signed and the QE report re-bound and re-signed by the fake PCK leaf.
   */
  const td15 = (svn2: Uint8Array) => {
    const header = quote.slice(0, 48);
    header.set([5, 0], 0);
    const body = new Uint8Array([3, 0, 648 & 255, 648 >> 8, 0, 0, ...quote.subarray(48, 632), ...svn2, ...new Uint8Array(48)]);
    const q = new Uint8Array([...header, ...body, ...quote.subarray(632)]);
    const sig = 48 + body.length + 4;
    const ak = newKey();
    q.set(ak.pub.subarray(1), sig + 64);
    q.set(p256.sign(sha256(q.subarray(0, 48 + body.length)), ak.sk).toCompactRawBytes(), sig);
    const qeAt = sig + 128 + 6;
    const authLen = q[qeAt + 448] | (q[qeAt + 449] << 8);
    q.set(sha256(new Uint8Array([...ak.pub.subarray(1), ...q.subarray(qeAt + 450, qeAt + 450 + authLen)])), qeAt + 320);
    q.set(p256.sign(sha256(q.subarray(qeAt, qeAt + 384)), lk.sk).toCompactRawBytes(), qeAt + 384);
    return q;
  };
  return { make, run, td15, quote, root, serial: { leaf: serialOf(leaf), mid: serialOf(mid), signer: serialOf(signer) } };
}

describe("Intel collateral: CRLs, TCB info, QE identity, maximum age (N1b)", () => {
  it("accepts the genuine v4 quote with its genuine collateral, and the fake-Intel builder's", () => {
    expect(verifyTdxQuote(V4, C4, { now: NOW })).toEqual({ tcbStatus: "UpToDate", advisoryIds: [] });
    const f = fakeIntel();
    expect(f.run(f.make())()).toEqual({ tcbStatus: "UpToDate", advisoryIds: [] });
  });

  it("fails closed when collateral is missing", () => {
    expect(() => verifyTdxQuote(V4, undefined as unknown as Collateral, { now: NOW })).toThrow("collateral missing");
    expect(check(V4, { collateral: { ...C4, pck_crl: "" } })).toThrow("collateral missing");
  });

  it("rejects a revoked PCK certificate, PCK CA and collateral signing certificate", () => {
    const f = fakeIntel();
    expect(f.run(f.make({ pckRevoked: [f.serial.leaf] }))).toThrow("PCK certificate revoked");
    expect(f.run(f.make({ rootRevoked: [f.serial.mid] }))).toThrow("PCK CA certificate revoked");
    expect(f.run(f.make({ rootRevoked: [f.serial.signer] }))).toThrow("QE identity signing certificate revoked");
    expect(f.run(f.make({ pckRevoked: [hex("01"), hex("0203")] }))).not.toThrow(); // other serials do not matter
  });

  it("rejects revoked and out-of-date TCB levels, each with its own text", () => {
    const f = fakeIntel();
    const status = (s: string) => (j: { tcbLevels: { tcbStatus: string }[] }) => j.tcbLevels.forEach((l) => (l.tcbStatus = s));
    expect(f.run(f.make({ tcb: status("Revoked") }))).toThrow("TCB revoked (platform)");
    expect(f.run(f.make({ tcb: status("OutOfDate") }))).toThrow("TCB out of date (platform)");
    expect(f.run(f.make({ tcb: status("OutOfDateConfigurationNeeded") }))).toThrow("TCB out of date (platform)");
    expect(f.run(f.make({ tcb: status("Unheard") }))).toThrow("TCB status unknown (platform)");
    expect(f.run(f.make({ qe: status("Revoked") }))).toThrow("TCB revoked (QE)");
    expect(f.run(f.make({ qe: status("OutOfDate") }))).toThrow("TCB out of date (QE)");
    const mod = (s: string) => (j: { tdxModuleIdentities: { tcbLevels: { tcbStatus: string }[] }[] }) =>
      j.tdxModuleIdentities.forEach((m) => m.tcbLevels.forEach((l) => (l.tcbStatus = s)));
    expect(f.run(f.make({ tcb: mod("OutOfDate") }))).toThrow("TCB out of date (TDX module)");
    expect(f.run(f.make({ tcb: (j) => j.tcbLevels.forEach((l: { tcb: { pcesvn: number } }) => (l.tcb.pcesvn = 99)) }))).toThrow("TCB below every level Intel lists (platform)");
  });

  it("accepts levels that only need configuration or software hardening, and reports their advisories", () => {
    const f = fakeIntel();
    const r = f.run(f.make({ tcb: (j) => Object.assign(j.tcbLevels[0], { tcbStatus: "SWHardeningNeeded", advisoryIDs: ["INTEL-SA-00615"] }) }))();
    expect(r).toEqual({ tcbStatus: "SWHardeningNeeded", advisoryIds: ["INTEL-SA-00615"] });
  });

  it("reports the worst accepted status over the platform, TDX module and QE levels", () => {
    const f = fakeIntel();
    const qeConfig = (j: { tcbLevels: { tcbStatus: string }[] }) => (j.tcbLevels[0].tcbStatus = "ConfigurationNeeded");
    expect(f.run(f.make({ qe: qeConfig }))().tcbStatus).toBe("ConfigurationNeeded");
    const both = f.make({ qe: qeConfig, tcb: (j) => (j.tcbLevels[0].tcbStatus = "SWHardeningNeeded") });
    expect(f.run(both)().tcbStatus).toBe("ConfigurationAndSWHardeningNeeded");
  });

  it("checks the current TCB of a TD 1.5 quote too", () => {
    const f = fakeIntel();
    const launch = V4.subarray(48, 64); // TEE_TCB_SVN of the sample: module ISVSVN, module version 1, …
    expect(f.run(f.make(), NOW, f.td15(launch))()).toEqual({ tcbStatus: "UpToDate", advisoryIds: [] });
    const lowModule = launch.slice();
    lowModule[0] = 2; // TDX_01 lists ISVSVN 2 as OutOfDate
    expect(f.run(f.make(), NOW, f.td15(lowModule))).toThrow("TCB out of date (TDX module)");
    const lowPlatform = launch.slice();
    lowPlatform[2] = 0; // TDX late microcode below every platform level
    expect(f.run(f.make(), NOW, f.td15(lowPlatform))).toThrow("TCB below every level Intel lists (platform)");
  });

  it("rejects too-old collateral even before its nextUpdate", () => {
    const f = fakeIntel();
    const old = NOW.getTime() - MAX_COLLATERAL_AGE_MS - H;
    expect(f.run(f.make({ crlIssued: old }))).toThrow("PCK CRL too old");
    const c = f.make({ issued: old, crlIssued: NOW.getTime() - H });
    expect(f.run(c)).toThrow("QE identity too old");
    expect(f.run({ ...c, qe_identity: f.make().qe_identity, qe_identity_signature: f.make().qe_identity_signature })).toThrow("TCB info too old");
    expect(f.run(f.make({ issued: NOW.getTime() - MAX_COLLATERAL_AGE_MS + H }))).not.toThrow();
    // Genuine collateral, four days later: Intel still lists it until nextUpdate, the bundle does not.
    expect(check(V4, { now: new Date(NOW.getTime() + 4 * DAY) })).toThrow("PCK CRL too old");
  });

  it("rejects expired collateral", () => {
    const f = fakeIntel();
    const issued = NOW.getTime() - 2 * DAY;
    expect(f.run(f.make({ issued, next: NOW.getTime() - DAY }))).toThrow("root CA CRL expired");
    expect(check(V4, { now: new Date("2026-05-01T00:00:00Z") })).toThrow("root CA CRL expired"); // genuine, nextUpdate 2026-04-03
    expect(f.run(f.make({ issued, next: NOW.getTime() - DAY, crlIssued: NOW.getTime() - H, crlNext: NOW.getTime() + DAY }))).toThrow("QE identity expired");
  });

  it("reports a device clock behind Intel's as its own error, within a small tolerance", () => {
    const latest = Date.parse("2025-06-19T10:32:27Z"); // the genuine QE identity's issueDate, the latest item
    expect(check(V4, { now: new Date(latest - CLOCK_TOLERANCE_MS + 60_000) })).not.toThrow();
    expect(check(V4, { now: new Date(latest - CLOCK_TOLERANCE_MS - 60_000) })).toThrow("QE identity issued in the future: the device clock is wrong");
    expect(check(V4, { now: new Date(latest - DAY) })).toThrow("PCK CRL issued in the future: the device clock is wrong");
  });

  it("rejects tampered collateral", () => {
    const flipHex = (h: string, at: number) => h.slice(0, at) + (h[at] === "0" ? "1" : "0") + h.slice(at + 1);
    expect(check(V4, { collateral: { ...C4, root_ca_crl: flipHex(C4.root_ca_crl, C4.root_ca_crl.length - 10) } })).toThrow("root CA CRL signature invalid");
    expect(check(V4, { collateral: { ...C4, pck_crl: flipHex(C4.pck_crl, 600) } })).toThrow("PCK CRL signature invalid");
    expect(check(V4, { collateral: { ...C4, tcb_info: C4.tcb_info.replace('"UpToDate"', '"UpToDatf"') } })).toThrow("TCB info signature invalid");
    expect(check(V4, { collateral: { ...C4, qe_identity: C4.qe_identity.replace("\"isvprodid\":2", "\"isvprodid\":3") } })).toThrow("QE identity signature invalid");
    expect(check(V4, { collateral: { ...C4, tcb_info_signature: "00" } })).toThrow("TCB info signature invalid");
  });

  it("rejects collateral signed by anyone but the Intel root", () => {
    const f = fakeIntel();
    const fake = f.make();
    // Genuine quote and root, fake TCB info with its own signer: the signer does not chain to Intel.
    expect(check(V4, { collateral: { ...C4, tcb_info_issuer_chain: fake.tcb_info_issuer_chain, tcb_info: fake.tcb_info, tcb_info_signature: fake.tcb_info_signature } }))
      .toThrow("TCB info signing certificate is not from the Intel root");
    // A PCK CRL from the fake PCK CA, which is not the CA that issued the genuine leaf's chain.
    expect(check(V4, { collateral: { ...C4, pck_crl: fake.pck_crl } })).toThrow("PCK CRL signature invalid");
  });

  it("requires the QE report to come from Intel's TD QE", () => {
    const f = fakeIntel();
    expect(f.run(f.make({ qe: (j) => (j.mrsigner = "00".repeat(32)) }))).toThrow("QE report is not from Intel's QE (MRSIGNER)");
    expect(f.run(f.make({ qe: (j) => (j.isvprodid = 1) }))).toThrow("QE report is not from Intel's QE (ISVPRODID)");
    expect(f.run(f.make({ qe: (j) => (j.attributes = "FF" + j.attributes.slice(2)) }))).toThrow("QE attributes does not match Intel's identity");
    expect(f.run(f.make({ qe: (j) => (j.id = "QE") }))).toThrow("QE identity is not for the TDX QE");
    expect(f.run(f.make({ qe: (j) => (j.miscselect = "01000000") }))).toThrow("QE MISCSELECT does not match Intel's identity");
  });

  it("requires TCB info for this platform and this TDX module", () => {
    // Genuine v5 collateral is for FMSPC 90C06F000000; the v4 quote's platform is B0C06F000000.
    expect(check(V4, { collateral: C5, now: NOW5 })).toThrow("TCB info is for another platform (FMSPC)");
    const f = fakeIntel();
    expect(f.run(f.make({ tcb: (j) => (j.id = "SGX") }))).toThrow("TCB info is not TDX TCB info v3");
    expect(f.run(f.make({ tcb: (j) => j.tdxModuleIdentities.forEach((m: { mrsigner: string }) => (m.mrsigner = "11".repeat(48))) })))
      .toThrow("TDX module signer does not match Intel's TCB info");
    expect(f.run(f.make({ tcb: (j) => (j.tdxModuleIdentities = []) }))).toThrow("TCB info has no TDX module TDX_");
  });

  it("names the collateral a quote needs", () => {
    expect(collateralQuery(V4)).toEqual({ fmspc: "B0C06F000000", ca: "platform" });
    expect(collateralQuery(V5)).toEqual({ fmspc: "90C06F000000", ca: "platform" });
    expect(() => collateralQuery(V4.subarray(0, 100))).toThrow(DcapError);
  });
});
