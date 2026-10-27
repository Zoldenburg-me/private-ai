import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { hexToBytes } from "@noble/hashes/utils";
import { nearKey, sealField, openField, sealRequest, openReply, mapRequestFields, NearE2eError } from "../lib/client/e2e/near";

// Made with nearai-cloud-verifier@9455472 py/encrypted_agent_loop_verifier.py (encrypt_to_server,
// decrypt_from_server, copied verbatim) with os.urandom pinned: Ed25519 seeds 0x11×32 (server) and
// 0x22×32 (client), ephemeral X25519 key 0x33×32 / nonce 0x44×24 for the request and 0x55 / 0x66 for the reply.
const V = {
  serverSeed: hexToBytes("11".repeat(32)),
  serverPub: "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737",
  clientSeed: hexToBytes("22".repeat(32)),
  clientPub: "a09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0",
  reqText: "Hallo, Enklave! 🔒",
  req: "7b0d47d93427f8311160781c7c733fd89f88970aef490d8aa0ee19a4cb8a1b14444444444444444444444444444444444444444444444444a181ebb31e7d1f1633422f81cff7bba266fd1c7d738df70001c089a283e7168fcfe71c8d",
  respText: "Antwort aus dem Enklave.",
  resp: "38ab664bd86f77d7e66bdd9ae0792913a94fd8b33a1260027e4b46c1f4884c6766666666666666666666666666666666666666666666666612fe0bb1fd808d2f183c56eff414a46fe6f5764316c75b668c4615248f40ad28a796fbb17b383bf4",
};
const pinned = (...chunks: string[]) => {
  const q = chunks.map(hexToBytes);
  return (n: number) => {
    const b = q.shift()!;
    expect(b.length).toBe(n);
    return b;
  };
};
const enclave = { seed: V.serverSeed, pub: V.serverPub };
const openAt = (seed: Uint8Array) => (s: string) => openField(s, seed);

describe("NEAR E2EE v2 fixed vector (NEAR's Python verifier)", () => {
  it("derives the same Ed25519 public keys", () => {
    expect(Buffer.from(ed25519.getPublicKey(V.serverSeed)).toString("hex")).toBe(V.serverPub);
    expect(Buffer.from(ed25519.getPublicKey(V.clientSeed)).toString("hex")).toBe(V.clientPub);
  });

  it("seals byte for byte like the verifier", () => {
    expect(sealField(V.reqText, V.serverPub, pinned("33".repeat(32), "44".repeat(24)))).toBe(V.req);
  });

  it("opens what the verifier sealed, in both directions", () => {
    expect(openField(V.req, V.serverSeed)).toBe(V.reqText);
    expect(openField(V.resp, V.clientSeed)).toBe(V.respText);
  });
});

describe("NEAR E2EE v2 fields", () => {
  it("round-trips and uses a fresh ephemeral key and nonce each time", () => {
    const a = sealField("hi", V.serverPub);
    const b = sealField("hi", V.serverPub);
    expect(a.slice(0, 112)).not.toBe(b.slice(0, 112));
    expect(openField(a, V.serverSeed)).toBe("hi");
  });

  it("rejects plaintext, short, odd or tampered fields", () => {
    expect(() => openField("hello", V.clientSeed)).toThrow(NearE2eError);
    expect(() => openField("ab".repeat(71), V.clientSeed)).toThrow("too short");
    expect(() => openField(V.resp + "0", V.clientSeed)).toThrow(NearE2eError);
    const flipped = V.resp.slice(0, -2) + (V.resp.endsWith("f4") ? "f5" : "f4");
    expect(() => openField(flipped, V.clientSeed)).toThrow(NearE2eError);
    expect(() => openField(V.resp, V.serverSeed)).toThrow(NearE2eError); // wrong key
  });

  it("rejects a malformed enclave key", () => {
    expect(() => sealField("x", "abcd")).toThrow(NearE2eError);
    expect(() => sealRequest({ messages: [] }, "abcd")).toThrow(NearE2eError); // even with nothing to seal
  });
});

describe("sealRequest", () => {
  const body = {
    model: "zai-org/GLM-5.1-FP8",
    stream: true,
    temperature: 0.3,
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      { role: "assistant", content: "", reasoning_content: "thinking", tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } }] },
      { role: "tool", tool_call_id: "call_1", name: "web_search", content: "result text" },
    ],
    tools: [
      { type: "function", function: { name: "web_search", description: "Search the web", parameters: { type: "object", properties: { query: { type: "string" } } } } },
      { type: "web_context_search" },
    ],
    tool_choice: { type: "function", function: { name: "web_search" } },
  };

  it("sends NEAR's v2 headers with a fresh client key per request", () => {
    const a = sealRequest(body, enclave.pub);
    const b = sealRequest(body, enclave.pub);
    expect(a.headers).toEqual({
      "X-Signing-Algo": "ed25519",
      "X-Client-Pub-Key": a.key.publicHex,
      "X-Encryption-Version": "2",
      "X-Encrypt-All-Fields": "true",
      "X-Model-Pub-Key": enclave.pub,
    });
    expect(Buffer.from(ed25519.getPublicKey(a.key.secret)).toString("hex")).toBe(a.key.publicHex);
    expect(a.key.publicHex).not.toBe(b.key.publicHex);
  });

  it("seals every content and tool field and leaves the routing fields plain", () => {
    const { body: sealed } = sealRequest(body, enclave.pub);
    const s = sealed as any;
    const m = s.messages as any[];
    for (const v of [m[0].content, m[1].content, m[2].reasoning_content, m[2].tool_calls[0].function.name, m[2].tool_calls[0].function.arguments,
      m[3].name, m[3].content, s.tools[0].function.name, s.tools[0].function.description, s.tools[0].function.parameters, s.tool_choice.function.name])
      expect(v).toMatch(/^[0-9a-f]{144,}$/);
    expect([s.model, s.stream, s.temperature, m.map((x) => x.role), m[2].content, m[2].tool_calls[0].id, m[3].tool_call_id, s.tools[1]])
      .toEqual([body.model, true, 0.3, ["system", "user", "assistant", "tool"], "", "call_1", "call_1", { type: "web_context_search" }]);
    expect(body.messages[0].content).toBe("Be brief."); // input untouched
  });

  it("seals image parts as one string and the enclave gets the same request back", () => {
    const { body: sealed } = sealRequest(body, enclave.pub);
    const opened = mapRequestFields(sealed, openAt(enclave.seed)) as any;
    expect(JSON.parse(opened.messages[1].content)).toEqual(body.messages[1].content);
    expect(JSON.parse(opened.tools[0].function.parameters)).toEqual(body.tools[0].function!.parameters);
    expect(opened.messages[2].tool_calls[0].function.arguments).toBe('{"query":"x"}');
    expect(opened.tool_choice.function.name).toBe("web_search");
  });
});

describe("every field NEAR decrypts is sealed (inference-proxy decrypt_request_fields)", () => {
  // One plaintext marker per path; none may survive sealRequest, and each must open back.
  const P = (n: number) => `secret-${n}-marker`;
  const body = {
    messages: [
      { role: "user", content: P(1), reasoning_content: P(2), reasoning: P(3), refusal: P(4), name: P(5),
        tool_calls: [{ id: "c", function: { name: P(6), arguments: P(7) } }], function_call: { name: P(8), arguments: P(9) } },
      { role: "user", content: [{ type: "text", text: P(10) }] },
    ],
    tools: [{ type: "function", function: { name: P(11), description: P(12), parameters: { description: P(13) } } }],
    tool_choice: { type: "function", function: { name: P(14) } },
    function_call: { name: P(15) },
  };
  it("leaves no plaintext and round-trips", () => {
    const { body: sealed } = sealRequest(body, enclave.pub);
    const wire = JSON.stringify(sealed);
    for (let n = 1; n <= 15; n++) expect(wire).not.toContain(P(n));
    const opened = JSON.stringify(mapRequestFields(sealed, openAt(enclave.seed)));
    for (let n = 1; n <= 15; n++) expect(opened).toContain(P(n));
  });
});

describe("openReply", () => {
  it("opens streamed content, reasoning, tool calls and tool results, and keeps usage plain", () => {
    const key = nearKey();
    const seal = (s: string) => sealField(s, key.publicHex);
    const chunk = {
      id: "chatcmpl-1", model: "m",
      choices: [{ index: 0, delta: {
        content: seal("Hello"), reasoning_content: seal("hmm"), reasoning: seal("hmm2"),
        tool_calls: [{ index: 0, id: "call_1", function: { name: seal("web_context_search"), arguments: seal('{"q":1}') } }],
        nearai_tool_result: { tool_call_id: "call_1", name: "web_context_search", status: "ok", output: seal("sources") },
      }, finish_reason: null }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    };
    const out = openReply(chunk, key.secret) as any;
    const d = out.choices[0].delta;
    expect([d.content, d.reasoning_content, d.reasoning, d.tool_calls[0].function.name, d.tool_calls[0].function.arguments, d.nearai_tool_result.output])
      .toEqual(["Hello", "hmm", "hmm2", "web_context_search", '{"q":1}', "sources"]);
    expect([out.id, out.usage, d.tool_calls[0].id, d.nearai_tool_result.status]).toEqual(["chatcmpl-1", chunk.usage, "call_1", "ok"]);
    expect(chunk.choices[0].delta.content).not.toBe("Hello"); // input untouched
  });

  it("opens a non-streamed message too", () => {
    const key = nearKey();
    const out = openReply({ choices: [{ message: { role: "assistant", content: sealField("Hi", key.publicHex) } }] }, key.secret) as any;
    expect(out.choices[0].message.content).toBe("Hi");
  });

  it("fails on a plaintext field instead of passing it through", () => {
    const key = nearKey();
    expect(() => openReply({ choices: [{ delta: { content: "injected" } }] }, key.secret)).toThrow(NearE2eError);
    expect(() => openReply({ choices: [{ delta: { tool_calls: [{ function: { arguments: "{}" } }] } }] }, key.secret)).toThrow(NearE2eError);
    const sealedDelta = { content: sealField("ok", key.publicHex) };
    expect(() => openReply({ choices: [{ delta: sealedDelta, message: { content: "injected" } }] }, key.secret)).toThrow(NearE2eError);
  });

  it.each([
    ["refusal", { choices: [{ delta: { refusal: "plain" } }] }],
    ["function_call", { choices: [{ delta: { function_call: { name: "plain" } } }] }],
    ["tool result", { choices: [{ delta: { nearai_tool_result: { output: "plain" } } }] }],
    ["string in a content array", { choices: [{ delta: { content: ["plain"] } }] }],
    ["content object", { choices: [{ delta: { content: { text: "plain" } } }] }],
    ["content part without text", { choices: [{ delta: { content: [{ type: "text", content: "plain" }] } }] }],
    ["choices object", { choices: { delta: { content: "plain" } } }],
    ["choices[].text", { choices: [{ text: "plain" }] }],
    ["delta string", { choices: [{ delta: "plain" }] }],
    ["arguments object", { choices: [{ delta: { tool_calls: [{ function: { name: "x", arguments: { q: "plain" } } }] } }] }],
    ["function string", { choices: [{ delta: { tool_calls: [{ function: "plain" }] } }] }],
    ["tool_calls object", { choices: [{ delta: { tool_calls: { function: { name: "plain" } } } }] }],
    ["reasoning object", { choices: [{ delta: { reasoning_content: { text: "plain" } } }] }],
    ["tool result object", { choices: [{ delta: { nearai_tool_result: { output: { text: "plain" } } } }] }],
  ])("rejects plaintext or an odd shape: %s", (_, chunk) => {
    expect(() => openReply(chunk, nearKey().secret)).toThrow(NearE2eError);
  });

  it("drops every field it does not open or know, so relay text cannot ride along", () => {
    const key = nearKey();
    const sealed = sealField("x", key.publicHex);
    const out = openReply({
      id: "i", error: { message: "plain" }, message: "plain", model: { a: "plain" }, usage: { total_tokens: 3, note: "plain", x: { a: "plain" } },
      choices: [{ index: 0, extra: "plain", finish_reason: { a: "plain" }, delta: { role: { a: "plain" },
        content: [{ type: "text", text: sealed, image_url: { url: "https://evil" } }], thinking: "plain", audio: { transcript: "plain" }, annotations: [{ title: "plain" }],
        tool_calls: [{ index: 0, function: { name: sealed, arguments: sealed, parsed: "plain" } }],
        nearai_tool_result: { output: sealed, error: "plain" },
      } }],
    }, key.secret);
    expect(JSON.stringify(out)).not.toContain("plain");
    expect(JSON.stringify(out)).not.toContain("evil");
    expect(out.choices?.[0].delta?.tool_calls?.[0].function).toEqual({ name: "x", arguments: "x" });
    expect(out.usage).toEqual({ total_tokens: 3 });
  });

  it("passes empty and final chunks", () => {
    const key = nearKey();
    const fin = { choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }], usage: { total_tokens: 1 } };
    expect(openReply(fin, key.secret)).toEqual(fin);
    for (const ok of [{ choices: [], usage: { total_tokens: 1 } }, { choices: [{ delta: { role: "assistant", content: null } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c" }] } }] }])
      expect(openReply(ok, key.secret)).toEqual(ok);
  });
});
