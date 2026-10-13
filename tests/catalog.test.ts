import { describe, it, expect } from "vitest";
import { normaliseModel, fetchCatalog, findSelectable } from "../lib/catalog";
import { loadProviders } from "../lib/providers";

describe("model catalog + privacy policy", () => {
  it("TEE provider models are tee + selectable", () => {
    const m = normaliseModel({ id: "near", privacy: "tee-attested" }, { id: "Qwen/Qwen3.8-27B" });
    expect(m).toMatchObject({ privacy: "tee", tee: true, selectable: true });
  });
  it("explicitly anonymized models are NOT selectable even on a TEE provider", () => {
    const m = normaliseModel({ id: "near", privacy: "tee-attested" }, { id: "x", privacy: "anonymized" });
    expect(m).toMatchObject({ privacy: "anonymized", selectable: false });
  });
  it("e2ee and zdr flags", () => {
    expect(normaliseModel({ id: "near", privacy: "tee-attested" }, { id: "e", capabilities: { e2ee: true } }).e2ee).toBe(true);
    expect(normaliseModel({ id: "redpill", privacy: "tee-gateway" }, { id: "z", zdr: true }).privacy).toBe("private");
    expect(normaliseModel({ id: "redpill", privacy: "tee-gateway" }, { id: "plain" }).selectable).toBe(false);
  });
  it("fetches /models and applies policy", async () => {
    const providers = loadProviders({ MOCK_PROVIDER: "1", MOCK_BASE_URL: "http://m/v1" });
    const fake = (async () => Response.json({ data: [{ id: "a" }, { id: "b", privacy: "anonymized" }] })) as unknown as typeof fetch;
    const cat = await fetchCatalog(providers, fake);
    expect(cat.map((m) => [m.id, m.selectable])).toEqual([["a", true], ["b", false]]);
    expect(findSelectable(cat, "mock", "a")).toBeTruthy();
    expect(findSelectable(cat, "mock", "b")).toBeUndefined();
  });
});
