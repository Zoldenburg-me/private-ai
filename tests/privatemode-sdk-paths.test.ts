import { describe, it, expect } from "vitest";
import { PrivatemodeAI } from "privatemode-ai";

// The real SDK, unmocked: privatemodeFetch passes the path after /v1, and the client's own base URL adds /v1 back.
// Its transport serves only /v1/models and /v1/chat/completions, so passing "/v1/..." would reach /v1/v1/... (501).
describe("privatemode-ai SDK paths", () => {
  it("resolves the path after /v1 to the transport's /v1 routes", () => {
    const c = new PrivatemodeAI({ apiKey: "test", enableWasmLogging: false, openAIOptions: { maxRetries: 0 } });
    expect(new URL(c.buildURL("/models", undefined)).pathname).toBe("/v1/models");
    expect(new URL(c.buildURL("/chat/completions", undefined)).pathname).toBe("/v1/chat/completions");
    c.close();
  });
});
