import { describe, it, expect, beforeEach } from "vitest";
import { normaliseModel, type ModelEntry } from "../lib/catalog";
import { cheapestRoute } from "../lib/routing";
import { handleChat } from "../lib/handler";
import { issueToken } from "../lib/session";
import { _reset } from "../lib/ratelimit";

const tee = (provider: string, raw: Record<string, unknown>) => normaliseModel({ id: provider, privacy: "tee-attested" }, raw);
// Real price shapes from each provider's /models (2026-10-20). NEAR is TEE only when its /model/list attests the model.
const near = normaliseModel({ id: "near", privacy: "tee-attested" }, { id: "moonshotai/kimi-k3", pricing: { prompt: "0.0000033", completion: "0.0000165" } }, true);
const phala = tee("phala", { id: "moonshotai/kimi-k3", pricing: { prompt: "0.000003", completion: "0.000015" } });
const tinfoil = tee("tinfoil", { id: "kimi-k3", pricing: { inputTokenPricePer1M: 4, outputTokenPricePer1M: 20 } });

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
    expect(cheapestRoute([tinfoil, near, phala], "kimi-k3")).toBe(phala);
    expect(cheapestRoute([tinfoil, near], "kimi-k3")).toBe(near);
  });
  it("an unpriced provider is used only when nothing priced is available", () => {
    const unpriced = tee("phala", { id: "moonshotai/kimi-k3" });
    expect(cheapestRoute([unpriced, tinfoil], "kimi-k3")).toBe(tinfoil);
    expect(cheapestRoute([unpriced], "kimi-k3")).toBe(unpriced);
  });
  it("never routes to a non-TEE entry, however cheap", () => {
    const notTee: ModelEntry = { ...near, tee: false, price: { in: 0, out: 0 } };
    expect(cheapestRoute([notTee, tinfoil], "kimi-k3")).toBe(tinfoil);
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
    const deps = { catalog: async () => [tinfoil, phala], env, fetchImpl, log: () => {} };
    const { token } = issueToken();
    const req = new Request("http://app/api/chat", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "auto:kimi-k3", messages: [{ role: "user", content: "hi" }] }) });
    const res = await handleChat(req, "/t", deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Provider")).toBe("phala");
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://inference.phala.com/v1/chat/completions");
    expect(sent[0].body.model).toBe("moonshotai/kimi-k3");
  });
});
