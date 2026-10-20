import { describe, it, expect } from "vitest";
import { loadProviders, pickProvider, buildChatRequest } from "../lib/providers";
describe("providers", () => {
  it("only loads providers with keys", () => {
    expect(loadProviders({})).toEqual([]);
    const ps = loadProviders({ NEAR_AI_API_KEY: "k", NEAR_AI_MODEL: "m" });
    expect(ps.map((p) => p.id)).toEqual(["near"]);
    expect(ps[0].baseUrl).toBe("https://cloud-api.near.ai/v1");
  });
  it("Venice is the anonymizing gateway, configured from env only", () => {
    const [v] = loadProviders({ VENICE_API_KEY: "k", VENICE_MODELS: "gpt-x, gpt-x" });
    expect(v).toMatchObject({ id: "venice", privacy: "anon-gateway", baseUrl: "https://api.venice.ai/api/v1", apiKey: "k", models: ["gpt-x"] });
    // Without an explicit frontier allowlist the gateway is off, so nothing unvetted is offered as "Frontier".
    expect(loadProviders({ VENICE_API_KEY: "k" })).toEqual([]);
    expect(loadProviders({ VENICE_API_KEY: "k", VENICE_MODELS: " , " })).toEqual([]);
  });
  it("picks default then first", () => {
    const env = { NEAR_AI_API_KEY: "a", PHALA_API_KEY: "b", DEFAULT_PROVIDER: "phala" };
    expect(pickProvider(undefined, env)?.id).toBe("phala");
    expect(pickProvider("near", env)?.id).toBe("near");
    expect(pickProvider("nope", { NEAR_AI_API_KEY: "a" })?.id).toBe("near");
  });
  it("builds streaming request", () => {
    const p = pickProvider(undefined, { CUSTOM_API_KEY: "x", CUSTOM_BASE_URL: "https://e.x/v1/", CUSTOM_MODEL: "m" })!;
    const { url, init } = buildChatRequest(p, [{ role: "user", content: "hi" }]);
    expect(url).toBe("https://e.x/v1/chat/completions");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "m", stream: true });
  });
});
