import { describe, it, expect, beforeEach } from "vitest";
import { findSelectable, normaliseModel, type ModelEntry } from "../lib/catalog";
import { cheapestRoute } from "../lib/routing";
import { handleChat } from "../lib/handler";
import { issueToken } from "../lib/session";
import { _reset } from "../lib/ratelimit";

const tee = (provider: string, raw: Record<string, unknown>) => normaliseModel({ id: provider, privacy: "tee-attested" }, raw);
// Real price shapes from each provider's /models (2026-10-20). NEAR is TEE only when its /model/list attests the model.
const near = normaliseModel({ id: "near", privacy: "tee-attested" }, { id: "moonshotai/kimi-k3", pricing: { prompt: "0.0000033", completion: "0.0000165" } }, true);
// Phala's own routing decides its TEE claim (lib/catalog.ts); these stand for models it serves from its enclaves alone.
const phala = tee("phala", { id: "moonshotai/kimi-k3", providers: ["phala"], pricing: { prompt: "0.000003", completion: "0.000015" } });
const tinfoil = tee("tinfoil", { id: "kimi-k3", pricing: { inputTokenPricePer1M: 4, outputTokenPricePer1M: 20 } });
const phalaGlm = tee("phala", { id: "z-ai/glm-5.3", providers: ["phala"], pricing: { prompt: "0.0000014", completion: "0.0000044" } });
const tinfoilGlm = tee("tinfoil", { id: "glm-5-3", pricing: { inputTokenPricePer1M: 1.8, outputTokenPricePer1M: 5.75 } });

describe("cheapest TEE routing", () => {
  it("reads both price formats as USD per 1M tokens", () => {
    expect(phala.price!.in).toBeCloseTo(3);
    expect(phala.price!.out).toBeCloseTo(15);
    expect(tinfoil.price).toEqual({ in: 4, out: 20 });
    expect(near.price!.in).toBeCloseTo(3.3); // NEAR has its own return path in normaliseModel
  });
  it("a blank or missing price is unknown, not free", () => {
    expect(tee("near", { id: "x", pricing: { prompt: "", completion: "" } }).price).toBeUndefined();
    expect(tee("near", { id: "x" }).price).toBeUndefined();
  });
  it("a non-object pricing field leaves that model unpriced instead of throwing", () => {
    for (const pricing of ["0", 0, true]) expect(tee("near", { id: "x", pricing }).price).toBeUndefined();
  });
  it("picks the cheapest provider that serves the model", () => {
    expect(cheapestRoute([tinfoil, near], "kimi-k3")).toBe(near);
    expect(cheapestRoute([tinfoilGlm, phalaGlm], "glm-5.3")).toBe(phalaGlm);
  });
  it("an unpriced provider is used only when nothing priced is available", () => {
    const unpriced = tee("tinfoil", { id: "kimi-k3" });
    expect(cheapestRoute([unpriced, near], "kimi-k3")).toBe(near);
    expect(cheapestRoute([unpriced], "kimi-k3")).toBe(unpriced);
  });
  it("never routes to a non-TEE entry, however cheap", () => {
    const notTee: ModelEntry = { ...near, tee: false, price: { in: 0, out: 0 } };
    expect(cheapestRoute([notTee, tinfoil], "kimi-k3")).toBe(tinfoil);
  });
  it("Kimi K3 never routes to Phala: it serves it via Chutes, whose attestation this app cannot check", () => {
    expect(cheapestRoute([phala], "kimi-k3")).toBeUndefined();
    expect(cheapestRoute([phala, tinfoil], "kimi-k3")).toBe(tinfoil);
  });
  it("unknown, uncurated or prototype keys resolve to nothing", () => {
    expect(cheapestRoute([near], "llama-y")).toBeUndefined();
    expect(cheapestRoute([near], "__proto__")).toBeUndefined();
    expect(cheapestRoute([near], "constructor")).toBeUndefined();
    expect(cheapestRoute([], "kimi-k3")).toBeUndefined();
  });
});

describe("auto: refs in the chat handler", () => {
  beforeEach(() => _reset());
  it("sends the request to the cheapest provider under that provider's own model id", async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ id: "chatcmpl-1", choices: [{ message: { content: "ok" } }] });
    }) as unknown as typeof fetch;
    const env = { PHALA_API_KEY: "k", TINFOIL_API_KEY: "k" };
    const deps = { catalog: async () => [tinfoilGlm, phalaGlm], env, fetchImpl, log: () => {} };
    const { token } = issueToken();
    const req = new Request("http://app/api/chat", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "auto:glm-5.3", messages: [{ role: "user", content: "hi" }] }) });
    const res = await handleChat(req, "/t", deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Provider")).toBe("phala");
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://inference.phala.com/v1/chat/completions");
    expect(sent[0].body.model).toBe("z-ai/glm-5.3");
  });
});

describe("modalities decide what can chat", () => {
  // Real NEAR /models entries (2026-10-24); every one of them is attested.
  const nearM = (id: string, i: string[], o: string[], params: string[] = ["temperature", "max_tokens"]) =>
    normaliseModel({ id: "near", privacy: "tee-attested" }, { id, input_modalities: i, output_modalities: o, supported_sampling_parameters: params }, true);
  const klein = nearM("black-forest-labs/FLUX.2-klein-4B", ["text"], ["image"], ["n"]);
  const whisper = nearM("openai/whisper-large-v3", ["audio"], ["text"], ["temperature"]);
  const embed = nearM("Qwen/Qwen3-Embedding-0.6B", ["text"], ["embedding"], []);
  const rerank = nearM("Qwen/Qwen3-Reranker-0.6B", ["text"], ["text"], []);
  const filter = nearM("openai/privacy-filter", ["text"], ["text"], []);
  const vision = nearM("Qwen/Qwen3-VL-30B-A3B-Instruct", ["text", "image"], ["text"]);
  const catalog = [klein, whisper, embed, rerank, filter, vision];

  it("only text-in, text-out generative models are selectable", () => {
    for (const m of [klein, whisper, embed, rerank, filter]) {
      expect(m.selectable).toBe(false);
      expect(findSelectable(catalog, "near", m.id)).toBeUndefined();
    }
    expect(findSelectable(catalog, "near", vision.id)).toBe(vision);
    expect(vision.modalities).toEqual({ in: ["text", "image"], out: ["text"] });
    expect(klein.modalities).toEqual({ in: ["text"], out: ["image"] });
  });

  it("reads NEAR's architecture block and Tinfoil's type", () => {
    expect(normaliseModel({ id: "near", privacy: "tee-attested" }, { id: "k", architecture: { inputModalities: ["text", "image"], outputModalities: ["text"] } }, true))
      .toMatchObject({ selectable: true, modalities: { in: ["text", "image"], out: ["text"] } });
    expect(tee("tinfoil", { id: "kimi-k3", type: "chat", multimodal: true }).modalities).toEqual({ in: ["text", "image"], out: ["text"] });
    expect(tee("tinfoil", { id: "glm-5-3", type: "chat", multimodal: false }).modalities).toEqual({ in: ["text"], out: ["text"] });
    expect(tee("tinfoil", { id: "qwen3-tts", type: "tts" })).toMatchObject({ selectable: false, modalities: { in: ["text"], out: ["audio"] } });
  });

  it("applies behind the anonymizing gateway too", () => {
    const venice = { id: "venice", privacy: "anon-gateway" } as const;
    expect(normaliseModel(venice, { id: "img", input_modalities: ["text"], output_modalities: ["image"] }).selectable).toBe(false);
    expect(normaliseModel(venice, { id: "chat" }).selectable).toBe(true);
    expect(normaliseModel(venice, { id: "c", input_modalities: ["Text"], output_modalities: ["TEXT"] })).toMatchObject({ selectable: true, modalities: { in: ["text"], out: ["text"] } });
  });

  it("a model with no modality data keeps its old verdict", () => {
    expect(near.modalities).toBeUndefined();
    expect(near.selectable).toBe(true);
    expect(tee("near", { id: "x", input_modalities: "text", output_modalities: ["text"] }).modalities).toBeUndefined(); // not an array: ignored
    const empty = tee("tinfoil", { id: "x", input_modalities: [], output_modalities: [] }); // empty: unknown
    expect(empty.modalities).toBeUndefined();
    expect(empty.selectable).toBe(true);
  });
});
