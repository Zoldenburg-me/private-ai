import { describe, it, expect } from "vitest";
import type { ModelEntry } from "../lib/catalog";
import { NO_FILTERS, ctxOn, fmtCtx, passes, sortRows, toRows } from "../app/models/rows";

const m = (o: Partial<ModelEntry> & Pick<ModelEntry, "id" | "provider">): ModelEntry =>
  ({ name: o.id, privacy: "tee", tee: true, e2ee: false, selectable: true, ...o });

describe("models page rows", () => {
  const catalog = [
    m({ id: "glm", provider: "near", name: "Zhipu: GLM 4.6", contextLength: 128_000 }),
    m({ id: "blocked", provider: "near", privacy: "anonymized", tee: false, selectable: false }),
    m({ id: "qwen", provider: "phala" }), // not offered in the chat picker
    m({ id: "gpt-6-astra", provider: "venice", name: "GPT-6 Astra", privacy: "anonymized", tee: false, incognito: true, paid: true, contextLength: 400_000 }),
  ];

  it("lists only models the chat offers, without inventing fields", () => {
    const rows = toRows(catalog);
    expect(rows.map((r) => r.key)).toEqual(["near:glm", "venice:gpt-6-astra"]);
    expect(rows[0]).toMatchObject({ name: "GLM 4.6", maker: "Zhipu", providerName: "NEAR AI Cloud", plan: "free", incognito: false, ctx: 128_000 });
    expect(rows[1]).toMatchObject({ providerName: "Venice", plan: "plus", incognito: true });
    expect(rows[1].maker).toBeUndefined();
    expect(toRows([m({ id: "x", provider: "near" })])[0].ctx).toBeUndefined();
  });

  it("keeps a model's Anon route next to its Medium one: both can be picked in the chat", () => {
    const rows = toRows([
      m({ id: "kimi-k3", provider: "venice", privacy: "private", tee: false, incognito: true }),
      m({ id: "kimi-k3", provider: "liquid", privacy: "anonymized", tee: false, incognito: true }),
      m({ id: "kimi-k3-alias", provider: "venice", privacy: "anonymized", tee: false, incognito: true }),
    ]);
    expect(rows.map((r) => [r.key, r.privacy])).toEqual([["venice:kimi-k3", "private"], ["liquid:kimi-k3", "anonymized"], ["venice:kimi-k3-alias", "anonymized"]]);
  });

  it("filters by privacy, provider, plan and search; skip ignores one filter", () => {
    const [glm, gpt] = toRows(catalog);
    expect(passes(gpt, { ...NO_FILTERS, plan: "free" })).toBe(false);
    expect(passes(gpt, { ...NO_FILTERS, plan: "plus" })).toBe(true); // paid-only models start at Plus
    expect(passes(gpt, { ...NO_FILTERS, plan: "pro" })).toBe(true);
    expect(passes(glm, { ...NO_FILTERS, privacy: ["anonymized"] })).toBe(false);
    expect(passes(glm, { ...NO_FILTERS, privacy: ["anonymized"] }, "privacy")).toBe(true);
    expect(passes(glm, { ...NO_FILTERS, query: "zhipu" })).toBe(true);
    expect(passes(glm, { ...NO_FILTERS, providers: ["venice"] })).toBe(false);
  });

  it("caps context at the plan and sorts", () => {
    const [glm, gpt] = toRows(catalog);
    expect(ctxOn(gpt, "pro")).toBe(128_000);
    expect(ctxOn(gpt, null)).toBe(400_000);
    expect([fmtCtx(8_000), fmtCtx(1_000_000), fmtCtx(undefined)]).toEqual(["8k", "1M", "—"]);
    expect(sortRows([glm, gpt], "ctx", -1).map((r) => r.key)).toEqual(["venice:gpt-6-astra", "near:glm"]);
  });
});
