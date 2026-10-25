import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { IMAGE_COST_MESSAGES, runAgent } from "../lib/agent";
import { imageType, promptOf } from "../lib/image-gen";
import { mockImage } from "../lib/mock-server";
import { parseSseChunk } from "../lib/sse";
import type { TierId } from "../lib/tiers";

const enc = new TextEncoder();
const sse = (events: unknown[]) => new Response(new ReadableStream({ start(c) {
  for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
  c.enqueue(enc.encode("data: [DONE]\n\n")); c.close();
} }));
const callStream = () => sse([{ id: "c1", choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "generate_image", arguments: `{"prompt":"a red cat"}` } }] }, finish_reason: "tool_calls" }] }]);
const answerStream = () => sse([{ id: "c2", choices: [{ delta: { content: "Here it is." } }] }, { id: "c2", choices: [{ delta: {}, finish_reason: "stop" }] }]);
const provider = { id: "phala", name: "Phala", privacy: "tee-attested" as const, baseUrl: "http://upstream/v1", apiKey: "k", defaultModel: "" };
const png = async () => ((await mockImage().json()) as { data: { b64_json: string }[] }).data[0].b64_json;

beforeAll(() => { process.env.MOCK_PROVIDER = "1"; }); // mockImage() checks it
afterAll(() => { delete process.env.MOCK_PROVIDER; });

/** A model that asks for one image, then answers; `image` is the image endpoint's base64 (null: never called). */
async function run(o: { tier?: TierId; image?: string; deny?: (n: number) => string | null; remaining?: string; chat?: typeof provider; near?: typeof provider }) {
  const bodies: Record<string, unknown>[] = []; const imageCalls: string[] = []; let charges = 0;
  const imageReqs: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.endsWith("/images/generations")) { imageCalls.push(String(init.body)); imageReqs.push({ url, auth: new Headers(init.headers).get("authorization") }); return Response.json({ data: [{ b64_json: o.image ?? await png() }] }); }
    bodies.push(JSON.parse(String(init.body)));
    return bodies.length === 1 ? callStream() : answerStream();
  }) as unknown as typeof fetch;
  const res = runAgent({ provider: o.chat ?? provider, imageProvider: o.near, body: { model: "m", messages: [{ role: "user", content: "draw a cat" }] }, maxSteps: 3, tier: o.tier, remaining: () => o.remaining,
    beforeStep: async () => { charges++; return o.deny?.(charges) ?? null; }, env: { MOCK_PROVIDER: "1" }, log: () => {}, route: "/api/agent", fetchImpl });
  const out = parseSseChunk((await res.text()) + "\n");
  const names = ((bodies[0].tools ?? []) as { type: string; function?: { name: string } }[]).map((t) => t.function?.name ?? t.type); // NEAR's own tool has no function
  return { bodies, out, names, imageCalls, imageReqs, charges, toolMsg: (bodies[1]?.messages as { role: string; content: string }[] | undefined)?.at(-1) };
}

describe("generate_image tool", () => {
  it("is offered on paid tiers only", async () => {
    expect((await run({ tier: "pro" })).names).toContain("generate_image");
    expect((await run({ tier: "free" })).names).not.toContain("generate_image");
    expect((await run({})).names).not.toContain("generate_image");
  });

  it("sends the image to the browser, never to the model, and charges it as several messages", async () => {
    const r = await run({ tier: "pro" });
    const done = r.out.tools.find((t) => t.status === "done")!;
    expect(done).toMatchObject({ name: "generate_image", query: "a red cat" });
    expect(done.image).toMatch(/^data:image\/png;base64,/);
    expect(r.toolMsg!.content).not.toContain("base64");
    expect(JSON.parse(r.imageCalls[0])).toMatchObject({ model: "black-forest-labs/FLUX.2-klein-4B", prompt: "a red cat", n: 1 });
    expect(r.charges).toBe(IMAGE_COST_MESSAGES + 1); // the image, then the answering step
    expect(r.out.deltas.join("")).toBe("Here it is.");
  });

  it("makes no paid call and charges nothing when too few messages are left", async () => {
    const r = await run({ tier: "pro", remaining: String(IMAGE_COST_MESSAGES - 1) });
    expect(r.imageCalls).toHaveLength(0);
    expect(r.toolMsg!.content).toMatch(/^error: no image/);
    expect(r.out.tools.map((t) => t.status)).toEqual(["running", "error"]);
    expect(r.charges).toBe(1); // only the answering step
  });

  it("is not offered on NEAR chats, whose tool calls NEAR runs itself", async () => {
    expect((await run({ tier: "pro", chat: { ...provider, id: "near" } })).names).not.toContain("generate_image");
  });

  it("uses the NEAR key liveProviders resolved (a key stored in /admin), not env", async () => {
    const r = await run({ tier: "pro", near: { ...provider, id: "near", baseUrl: "https://near.example/v1", apiKey: "stored" } });
    expect(r.imageReqs).toEqual([{ url: "https://near.example/v1/images/generations", auth: "Bearer stored" }]);
  });

  it("treats a tiny placeholder as a refusal that costs nothing", async () => {
    const tiny = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).toString("base64");
    const r = await run({ tier: "pro", image: tiny });
    expect(r.out.tools.map((t) => t.status)).toEqual(["running", "error"]);
    expect(r.toolMsg!.content).toMatch(/^error: no image/);
    expect(r.charges).toBe(1);
  });

  it("refuses an oversized upstream body without parsing it", async () => {
    const r = await run({ tier: "pro", image: "A".repeat(6_000_000) });
    expect(r.out.tools.map((t) => t.status)).toEqual(["running", "error"]);
  });
});

describe("image helpers", () => {
  it("parses prompts and sniffs image types", () => {
    expect(promptOf('{"prompt":"  a cat "}')).toBe("a cat");
    expect(promptOf('{"prompt":""}')).toBeNull();
    expect(promptOf("not json")).toBeNull();
    expect(imageType(Buffer.from([0xff, 0xd8, 0xff, 0]))).toBe("jpeg");
    expect(imageType(Buffer.from("RIFF0000WEBP"))).toBe("webp");
    expect(imageType(Buffer.from("<svg"))).toBeNull();
  });

  it("the client keeps only inline image data URLs", () => {
    const ev = (image: string) => `event: agent_tool\ndata: ${JSON.stringify({ id: "1", name: "generate_image", status: "done", image })}\n\n`;
    expect(parseSseChunk(ev("data:image/png;base64,iVBORw0K")).tools[0].image).toBe("data:image/png;base64,iVBORw0K");
    expect(parseSseChunk(ev("https://evil.example/x.png")).tools[0].image).toBeUndefined();
    expect(parseSseChunk(ev("data:image/svg+xml;base64,PHN2Zz4=")).tools[0].image).toBeUndefined();
  });
});
