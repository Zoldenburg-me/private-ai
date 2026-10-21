import { describe, it, expect } from "vitest";
import type { ModelEntry } from "../lib/catalog";
import { AUTO, autoRef, autoRouteNote, levelModels, levelOf, nextUnbench, resolveRef } from "../lib/client/levels";
import { summarise, ROUTE_COOLDOWN_MS, type Proof } from "../lib/client/proof";

const m = (provider: string, id: string, privacy: ModelEntry["privacy"], extra: Partial<ModelEntry> = {}): ModelEntry =>
  ({ id, provider, name: id, privacy, tee: privacy === "tee", e2ee: false, selectable: true, ...(privacy === "tee" ? {} : { incognito: true as const }), ...extra });
const auto = { ...m("auto", "kimi-k3", "tee"), name: "Auto · Kimi K3", routes: ["tinfoil:kimi-k3", "near:moonshotai/kimi-k3"] };
const models: ModelEntry[] = [
  auto,
  m("near", "moonshotai/kimi-k3", "tee"),
  m("near", "other/tee-only", "tee"),
  m("venice", "kimi-k3", "private"),
  m("venice", "deepseek-v4-1-flash", "private"),
  m("liquid", "kimi-k3", "anonymized"),
  m("liquid", "deepseek-v4.1-flash", "anonymized"),
  m("liquid", "qwen3.8-27b", "anonymized"),
  m("venice", "qwen-3-8-27b", "anonymized"),
  m("liquid", "gpt-6-astra", "anonymized", { paid: true }),
];
const passing = (ref: string): Proof => ({ ...summarise(ref, []), level: "checks-passed", label: "", modelRef: ref });
const NOW = 1_000_000;

describe("privacy levels", () => {
  it("maps enclave, zero-retention and anonymized models to Max, Medium and Anon", () => {
    expect(models.map(levelOf)).toEqual(["max", "max", "max", "medium", "medium", "anon", "anon", "anon", "anon", "anon"]);
  });

  it("without provider choice: Max lists each model once (Auto-routed where curated), Medium/Anon one row per model", () => {
    expect(levelModels(models, "max", false).map((x) => `${x.provider}:${x.id}`)).toEqual(["auto:kimi-k3", "near:other/tee-only"]);
    expect(levelModels(models, "anon", false).map((x) => `${x.provider}:${x.id}`)).toEqual(["liquid:kimi-k3", "liquid:deepseek-v4.1-flash", "liquid:qwen3.8-27b", "liquid:gpt-6-astra"]);
  });

  it("with provider choice: every provider's row, never an Auto row", () => {
    expect(levelModels(models, "max", true).map((x) => x.provider)).toEqual(["near", "near"]);
    expect(levelModels(models, "anon", true)).toHaveLength(5);
  });

  it("Auto on Max is the curated Auto entry; on Medium/Anon the first listed model that has not failed recently, never a paid one", () => {
    expect(autoRef(models, "max", {}, NOW)).toBe("auto:kimi-k3");
    expect(autoRef(models, "medium", {}, NOW)).toBe("venice:deepseek-v4-1-flash");
    expect(autoRef(models, "anon", {}, NOW)).toBe("liquid:deepseek-v4.1-flash");
    expect(autoRef(models, "anon", { "liquid:deepseek-v4.1-flash": NOW - 1000 }, NOW)).toBe("liquid:qwen3.8-27b");
    expect(autoRef(models, "anon", { "liquid:deepseek-v4.1-flash": NOW - ROUTE_COOLDOWN_MS - 1 }, NOW)).toBe("liquid:deepseek-v4.1-flash");
  });

  it("Medium/Anon Auto sends nowhere while every candidate is benched, and says when it tries again", () => {
    const allFailed = Object.fromEntries(models.filter((x) => levelOf(x) === "medium").map((x) => [`${x.provider}:${x.id}`, NOW - 1000]));
    expect(autoRef(models, "medium", allFailed, NOW)).toBe("");
    expect(resolveRef(models, "medium", AUTO, false, allFailed, NOW)).toBe("");
    expect(nextUnbench(allFailed, NOW)).toBe(ROUTE_COOLDOWN_MS - 1000);
    expect(nextUnbench({ x: NOW - ROUTE_COOLDOWN_MS - 1 }, NOW)).toBeUndefined();
    expect(autoRouteNote({ models, ref: "", auto: true, proof: undefined, failedAt: allFailed, level: "medium", now: NOW })).toMatch(/every model.*failed/i);
    expect(autoRouteNote({ models, ref: "", auto: true, proof: undefined, failedAt: {}, now: NOW })).toBeUndefined();
  });

  it("a remembered pick holds only while that level's list still offers it; otherwise Auto", () => {
    expect(resolveRef(models, "medium", "venice:kimi-k3", false, {}, NOW)).toBe("venice:kimi-k3");
    expect(resolveRef(models, "medium", "liquid:kimi-k3", false, {}, NOW)).toBe("venice:deepseek-v4-1-flash"); // an Anon model
    expect(resolveRef(models, "max", "near:gone", false, {}, NOW)).toBe("auto:kimi-k3");
    expect(resolveRef(models, "max", AUTO, false, {}, NOW)).toBe("auto:kimi-k3");
  });

  it("follows Pick a provider: a provider row counts only while it is on, a curated Auto row only while it is off", () => {
    expect(resolveRef(models, "max", "near:moonshotai/kimi-k3", true, {}, NOW)).toBe("near:moonshotai/kimi-k3");
    expect(resolveRef(models, "max", "near:moonshotai/kimi-k3", false, {}, NOW)).toBe("auto:kimi-k3"); // routed again, not stuck on NEAR
    expect(resolveRef(models, "max", "auto:kimi-k3", false, {}, NOW)).toBe("auto:kimi-k3");
    expect(resolveRef(models, "anon", "liquid:qwen3.8-27b", false, {}, NOW)).toBe("liquid:qwen3.8-27b");
    expect(resolveRef(models, "anon", "venice:qwen-3-8-27b", false, {}, NOW)).toBe("liquid:deepseek-v4.1-flash"); // hidden duplicate row
    expect(resolveRef(models, "anon", "venice:qwen-3-8-27b", true, {}, NOW)).toBe("venice:qwen-3-8-27b");
  });

  it("explains which route Auto uses and why", () => {
    const note = (proof: Proof | undefined, failedAt: Record<string, number> = {}) => autoRouteNote({ models, ref: "auto:kimi-k3", auto: true, proof, failedAt, now: NOW });
    expect(note(undefined)).toMatch(/checking/i);
    expect(note(passing("tinfoil:kimi-k3"))).toMatch(/Tinfoil.*cheapest enclave/);
    expect(note(passing("near:moonshotai/kimi-k3"), { "tinfoil:kimi-k3": NOW - 1000 })).toMatch(/NEAR AI Cloud[\s\S]*Skipped.*Tinfoil/);
    expect(note(passing("near:other/tee-only"))).toMatch(/fallback/i);
    expect(autoRouteNote({ models, ref: "liquid:deepseek-v4.1-flash", auto: true, proof: undefined, failedAt: {}, now: NOW })).toMatch(/deepseek-v4\.1-flash.*Liquid/i);
    expect(autoRouteNote({ models, ref: "venice:kimi-k3", auto: false, proof: undefined, failedAt: {}, now: NOW })).toBeUndefined();
  });
});
