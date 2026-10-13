import { secp256k1 } from "@noble/curves/secp256k1";
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
