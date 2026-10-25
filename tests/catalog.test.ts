import { describe, it, expect } from "vitest";
import { normaliseModel, fetchCatalog, findSelectable } from "../lib/catalog";
import { loadProviders } from "../lib/providers";

describe("model catalog + privacy policy", () => {
  it("TEE provider models are tee + selectable", () => {
    const m = normaliseModel({ id: "tinfoil", privacy: "tee-attested" }, { id: "kimi-k3" });
    expect(m).toMatchObject({ privacy: "tee", tee: true, selectable: true });
  });
  it("Phala: TEE only where its own /models routes the model to Phala alone, whatever else it claims", () => {
    const phala = { id: "phala", privacy: "tee-attested" } as const;
    // Shapes from Phala's live /models (2026-10-25): it marks every model is_tee and routes many to other backends.
    expect(normaliseModel(phala, { id: "phala/qwen3.8-27b-uncensored", is_tee: true, providers: ["phala"] })).toMatchObject({ privacy: "tee", tee: true, selectable: true });
    for (const raw of [
      { id: "moonshotai/kimi-k3", is_tee: true, providers: ["chutes"] }, // Chutes' attestation cannot be checked here
      { id: "qwen/qwen3.8-27b", is_tee: true, providers: ["chutes", "phala"] }, // any one request may go to Chutes
      { id: "z-ai/glm-5.3", is_tee: true, providers: ["0g-private-computer", "privatemode", "tinfoil"] },
      { id: "x", is_tee: true, providers: [] },
      { id: "x", tee: true, privacy: "tee" }, // no routing data (e.g. the allowlist fallback while /models is down)
      { id: "x", zdr: true, providers: ["chutes"] },
      { id: "x", privacy: "private", providers: ["chutes"] },
    ]) expect(normaliseModel(phala, raw)).toMatchObject({ tee: false, selectable: false });
  });
  it("anonymized models are selectable only through the anonymizing gateway", () => {
    const m = normaliseModel({ id: "near", privacy: "tee-attested" }, { id: "x", privacy: "anonymized" });
    expect(m).toMatchObject({ privacy: "anonymized", selectable: false });
    const f = normaliseModel({ id: "venice", privacy: "anon-gateway" }, { id: "claude-fable-5-1", model_spec: { privacy: "anonymized" } });
    expect(f).toMatchObject({ provider: "venice", privacy: "anonymized", tee: false, e2ee: false, selectable: true });
  });
  it("a gateway never claims TEE or E2EE; only Venice's own private models count as zero retention", () => {
    const m = normaliseModel({ id: "venice", privacy: "anon-gateway" }, { id: "kimi-k3", tee: true, capabilities: { e2ee: true }, model_spec: { privacy: "private", name: "X" } });
    expect(m).toMatchObject({ name: "X", privacy: "private", tee: false, e2ee: false, selectable: true });
    expect(normaliseModel({ id: "venice", privacy: "anon-gateway" }, { id: "y", model_spec: { privacy: "anonymized" } }).privacy).toBe("anonymized");
    expect(normaliseModel({ id: "liquid", privacy: "anon-gateway" }, { id: "z", model_spec: { privacy: "private" } }).privacy).toBe("anonymized");
  });
  it("<PREFIX>_MODELS limits a provider's catalogue to the listed ids", async () => {
    const providers = loadProviders({ VENICE_API_KEY: "k", VENICE_MODELS: "gpt-x, claude-fable-5-1" });
    const fake = (async () => Response.json({ data: [{ id: "gpt-x" }, { id: "claude-fable-5-1" }, { id: "llama-y" }] })) as unknown as typeof fetch;
    expect((await fetchCatalog(providers, fake)).map((m) => m.id)).toEqual(["gpt-x", "claude-fable-5-1"]);
    const down = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    // /models down: the allowlist is the fallback, and an unlisted default model is never offered.
    const fallback = await fetchCatalog(loadProviders({ VENICE_API_KEY: "k", VENICE_MODELS: "gpt-x, claude-fable-5-1", VENICE_MODEL: "llama-y" }), down);
    expect(fallback.map((m) => [m.id, m.privacy, m.selectable])).toEqual([["gpt-x", "anonymized", true], ["claude-fable-5-1", "anonymized", true]]);
  });
  it("only Tinfoil's chat models are selectable, by the type its /models lists", () => {
    const tinfoil = { id: "tinfoil", privacy: "tee-attested" } as const;
    expect(normaliseModel(tinfoil, { id: "gpt-oss-120b", type: "chat" }).selectable).toBe(true);
    for (const [id, type] of [["nomic-embed-text", "embedding"], ["qwen3-tts", "tts"], ["gpt-oss-safeguard-120b", "safety"], ["websearch", "tool"]])
      expect(normaliseModel(tinfoil, { id, type })).toMatchObject({ privacy: "tee", selectable: false });
    // No type (the allowlist fallback when /models is down): the operator picked it, keep it.
    expect(normaliseModel(tinfoil, { id: "gpt-oss-120b" }).selectable).toBe(true);
    expect(normaliseModel({ id: "mock", privacy: "tee-attested" }, { id: "e", type: "embedding" }).selectable).toBe(true);
  });
  it("only Privatemode's generate models are selectable, by the tasks its /models lists", () => {
    const pm = { id: "privatemode", privacy: "tee-attested" } as const;
    expect(normaliseModel(pm, { id: "glm-5.3", tasks: ["generate", "tool_calling"] })).toMatchObject({ privacy: "tee", selectable: true });
    for (const [id, task] of [["qwen3-embedding-4b", "embed"], ["whisper-large-v3", "transcribe"], ["docs", "unstructured"]])
      expect(normaliseModel(pm, { id, tasks: [task] }).selectable).toBe(false);
    // No tasks (the allowlist fallback when /models is down): the operator picked it, keep it.
    expect(normaliseModel(pm, { id: "glm-5.3" }).selectable).toBe(true);
    expect(normaliseModel({ id: "mock", privacy: "tee-attested" }, { id: "e", tasks: ["embed"] }).selectable).toBe(true);
  });
  it("Privatemode works with only a key: no local proxy URL needed", () => {
    expect(loadProviders({ PRIVATEMODE_API_KEY: "k" })).toMatchObject([{ id: "privatemode", baseUrl: "https://api.privatemode.ai/v1" }]);
  });
  it("e2ee and zdr flags", () => {
    expect(normaliseModel({ id: "mock", privacy: "tee-attested" }, { id: "e", capabilities: { e2ee: true } }).e2ee).toBe(true);
    expect(normaliseModel({ id: "redpill", privacy: "tee-gateway" }, { id: "z", zdr: true }).privacy).toBe("private");
    expect(normaliseModel({ id: "redpill", privacy: "tee-gateway" }, { id: "plain" }).selectable).toBe(false);
    // RedPill's /models marks confidential models with is_tee; standard ones stay unselectable.
    expect(normaliseModel({ id: "redpill", privacy: "tee-gateway" }, { id: "deepseek/v4", is_tee: true })).toMatchObject({ privacy: "tee", selectable: true });
    expect(normaliseModel({ id: "redpill", privacy: "tee-gateway" }, { id: "openai/o3", is_tee: false }).selectable).toBe(false);
    // Negated privacy words never upgrade a model (same rule as "tee").
    for (const privacy of ["non-tee", "not tee", "guarantee", "not confidential", "non-confidential", "non-private", "not private", "non-zdr", "no zdr"])
      expect(normaliseModel({ id: "redpill", privacy: "tee-gateway" }, { id: "p", privacy }), privacy).toMatchObject({ privacy: "anonymized", tee: false, selectable: false });
    expect(normaliseModel({ id: "custom", privacy: "zdr-contract" }, { id: "p", privacy: "non-confidential" })).toMatchObject({ privacy: "private", tee: false });
    for (const privacy of ["tee-attested", "confidential"])
      expect(normaliseModel({ id: "redpill", privacy: "tee-gateway" }, { id: "p", privacy }), privacy).toMatchObject({ privacy: "tee", selectable: true });
    for (const privacy of ["private", "zdr", "zero-retention zdr"])
      expect(normaliseModel({ id: "redpill", privacy: "tee-gateway" }, { id: "p", privacy }), privacy).toMatchObject({ privacy: "private", selectable: true });
    expect(loadProviders({ REDPILL_API_KEY: "k" }).map((p) => p.baseUrl)).toEqual(["https://api.redpill.ai/v1"]);
  });
  it("fetches /models and applies policy", async () => {
    const providers = loadProviders({ MOCK_PROVIDER: "1", MOCK_BASE_URL: "http://m/v1" });
    const fake = (async () => Response.json({ data: [{ id: "a" }, { id: "b", privacy: "anonymized" }] })) as unknown as typeof fetch;
    const cat = await fetchCatalog(providers, fake);
    expect(cat.map((m) => [m.id, m.selectable])).toEqual([["a", true], ["b", false]]);
    expect(findSelectable(cat, "mock", "a")).toBeTruthy();
    expect(findSelectable(cat, "mock", "b")).toBeUndefined();
  });
  it("NEAR models are TEE only when NEAR's /model/list says attestation is supported", async () => {
    const providers = loadProviders({ NEAR_AI_API_KEY: "k" });
    const fake = (async (url: string) =>
      String(url).includes("/model/list")
        ? Response.json({ models: [
            { modelId: "moonshotai/kimi-k3", metadata: { attestationSupported: true, providerType: "chutes" } },
            { modelId: "anthropic/claude-fable-5", metadata: { attestationSupported: false, providerType: "external" } },
          ] })
        : Response.json({ data: [{ id: "moonshotai/kimi-k3" }, { id: "anthropic/claude-fable-5", tee: true, confidential: true, privacy: "private" }, { id: "new/unlisted" }] })) as unknown as typeof fetch;
    const cat = await fetchCatalog(providers, fake);
    // /model/list has the last word: other TEE or zero-retention hints in /models cannot override it.
    expect(cat.map((m) => [m.id, m.tee, m.selectable])).toEqual([
      ["moonshotai/kimi-k3", true, true],
      ["anthropic/claude-fable-5", false, false],
      ["new/unlisted", false, false],
    ]);
    // /model/list down: nothing from NEAR is claimed as TEE.
    const listDown = (async (url: string) => (String(url).includes("/model/list") ? new Response("", { status: 500 }) : fake(url))) as unknown as typeof fetch;
    expect((await fetchCatalog(providers, listDown)).some((m) => m.selectable)).toBe(false);
  });
  it("normaliseModel never trusts NEAR's own hints: only the /model/list verdict counts", () => {
    const near = { id: "near", privacy: "tee-attested" } as const;
    const hinted = normaliseModel(near, { id: "anthropic/claude-fable-5", tee: true, confidential: true, privacy: "private", zdr: true, capabilities: { tee: true, e2ee: true } });
    expect(hinted).toMatchObject({ privacy: "anonymized", tee: false, e2ee: false, selectable: false });
    expect(normaliseModel(near, { id: "moonshotai/kimi-k3" }, true)).toMatchObject({ privacy: "tee", tee: true, selectable: true });
  });
});
