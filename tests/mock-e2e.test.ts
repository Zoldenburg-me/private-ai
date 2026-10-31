import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { mockChat, mockAttestation } from "../lib/mock-server";
import { MOCK_ROOT_CA, mockEd25519Pub } from "../lib/mock-tee";
import { verifyTdxQuote } from "../lib/client/e2e/dcap";
import { parseTdxQuote, newNonce } from "../lib/attestation";
import { sealRequest, openReply, sealField } from "../lib/client/e2e/near";

const prev = process.env.MOCK_PROVIDER;
beforeAll(() => { process.env.MOCK_PROVIDER = "1"; });
afterAll(() => { process.env.MOCK_PROVIDER = prev; });

const post = (body: unknown, headers: Record<string, string>) =>
  mockChat(new Request("http://mock/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body) }));
const chunks = async (res: Response) =>
  (await res.text()).split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));

describe("mock enclave speaks NEAR E2EE v2", () => {
  it("attests an Ed25519 key that a DCAP check accepts only with the test root", async () => {
    const nonce = newNonce();
    const res = await mockAttestation(new Request(`http://mock/v1/attestation/report?model=mock-e2ee&signing_algo=ed25519&nonce=${nonce}`));
    const att = (await res.json()).model_attestations[0];
    expect(att).toMatchObject({ signing_algo: "ed25519", signing_public_key: mockEd25519Pub(), request_nonce: nonce });
    expect(bytesToHex(parseTdxQuote(att.intel_quote).reportData)).toBe(mockEd25519Pub() + nonce);
    const quote = hexToBytes(att.intel_quote);
    // The mock serves no collateral: with the test root, quote and PCK chain pass and the check stops only at
    // Intel's genuine collateral, which the mock root did not sign. The pinned Intel root rejects the chain itself.
    const intel = JSON.parse(readFileSync("tests/fixtures/dcap/tdx-quote-v4-collateral.json", "utf8"));
    expect(() => verifyTdxQuote(quote, intel, { root: MOCK_ROOT_CA })).toThrow("root CA CRL is from another issuer");
    expect(() => verifyTdxQuote(quote, intel)).toThrow("PCK chain names do not link");
  });

  it("refuses an Ed25519 report without a 32-byte nonce", async () => {
    const res = await mockAttestation(new Request("http://mock/v1/attestation/report?model=mock-e2ee&signing_algo=ed25519&nonce=abcd"));
    expect(res.status).toBe(400);
  });

  it("streams a sealed reply the browser opens, with plaintext usage", async () => {
    const { body, headers, key } = sealRequest({ model: "mock-e2ee", stream: true, messages: [{ role: "user", content: "Hi" }] }, mockEd25519Pub());
    const res = await post(body, headers);
    expect(res.status).toBe(200);
    const raw = await chunks(res);
    expect(raw.every((c) => !c.choices[0].delta.content || /^[0-9a-f]+$/.test(c.choices[0].delta.content))).toBe(true);
    const text = raw.map((c) => openReply(c, key.secret)).map((c: any) => c.choices[0].delta.content ?? "").join("");
    expect(text).toBe("This is a mock enclave reply.");
    expect(raw.at(-1).usage).toMatchObject({ completion_tokens: expect.any(Number) });
  });

  it("seals the tool call in agent mode", async () => {
    const tools = [{ type: "function", function: { name: "web_search", parameters: { type: "object" } } }];
    const { body, headers, key } = sealRequest({ model: "mock-e2ee", stream: true, messages: [{ role: "user", content: "Hi" }], tools }, mockEd25519Pub());
    const [c] = await chunks(await post(body, headers));
    expect(c.choices[0].delta.tool_calls[0].function.name).not.toBe("web_search");
    expect((openReply(c, key.secret) as any).choices[0].delta.tool_calls[0].function).toEqual({ name: "web_search", arguments: '{"query":"mock search"}' });
  });

  it("refuses a request whose content is not sealed to its key", async () => {
    const { headers } = sealRequest({ messages: [] }, mockEd25519Pub());
    expect((await post({ stream: true, messages: [{ role: "user", content: "plain" }] }, headers)).status).toBe(400);
    const other = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
    const wrongKey = { stream: true, messages: [{ role: "user", content: sealField("Hi", other) }] };
    expect((await post(wrongKey, headers)).status).toBe(400);
  });

  it("refuses v1, a missing client key and a pinned key that is not its own", async () => {
    const { body, headers } = sealRequest({ stream: true, messages: [{ role: "user", content: "Hi" }] }, mockEd25519Pub());
    expect((await post(body, { ...headers, "X-Encryption-Version": "1" })).status).toBe(400);
    expect((await post(body, { ...headers, "X-Client-Pub-Key": "zz" })).status).toBe(400);
    expect((await post(body, { ...headers, "X-Model-Pub-Key": "ab".repeat(32) })).status).toBe(400);
  });

  it("still answers plaintext requests as before", async () => {
    const res = await post({ stream: false, messages: [{ role: "user", content: "Hi" }] }, {});
    expect((await res.json()).choices[0].message.content).toBe("This is a mock enclave reply.");
  });
});
