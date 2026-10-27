import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { verifyTdxQuote, INTEL_SGX_ROOT_CA, DcapError } from "../lib/client/e2e/dcap";

// Official sample quotes from Phala-Network/dcap-qvl (MIT), sample/tdx_quote and sample/tdx_quote_outdated.
const fixture = (name: string) => hexToBytes(readFileSync(`tests/fixtures/dcap/${name}`, "utf8").trim());
const V4 = fixture("tdx-quote-v4.hex");
const V5 = fixture("tdx-quote-v5.hex"); // v5, TD 1.5 body
const NOW = new Date("2026-10-27T00:00:00Z");

const check = (q: Uint8Array, opts: Parameters<typeof verifyTdxQuote>[1] = {}) => () => verifyTdxQuote(q, { now: NOW, ...opts });
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

describe("Intel TDX DCAP quote verification (N1a)", () => {
  it("pins the published Intel SGX Root CA", () => {
    expect(bytesToHex(sha256(INTEL_SGX_ROOT_CA))).toBe("44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3");
  });

  it("accepts genuine v4 and v5 quotes", () => {
    expect(check(V4)).not.toThrow();
    expect(check(V5)).not.toThrow();
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
    expect(fakeChain()).not.toThrow(); // the builder makes a chain the verifier accepts
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
