import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { normaliseModel } from "@/lib/catalog";
import { routesByPrice } from "@/lib/routing";
import { autoEntryOf, autoModels, defaultModelRef, visibleModels } from "@/lib/client/providers";
import { autoCandidates, autoRetryDelay, fallbackOf, firstPassing, handoffReady, isBenched, serverCheckedProof, isServerChecked, sdkProof, LEVEL_LABEL, ROUTE_COOLDOWN_MS, type Proof } from "@/lib/client/proof";
import { ProofBadge } from "@/components/app/ProofBadge";
import { ModelPicker } from "@/components/app/ModelPicker";
import { enclaveLine } from "@/components/app/ChatThread";

const tee = (provider: string, raw: Record<string, unknown>) => normaliseModel({ id: provider, privacy: "tee-attested" }, raw);
const near = normaliseModel({ id: "near", privacy: "tee-attested" }, { id: "moonshotai/kimi-k3", name: "Kimi K3", pricing: { prompt: "0.0000033", completion: "0.0000165" } }, true);
const phala = tee("phala", { id: "moonshotai/kimi-k3", name: "Kimi K3", pricing: { prompt: "0.000003", completion: "0.000015" } });
const tinfoil = tee("tinfoil", { id: "kimi-k3", name: "Kimi K3", pricing: { inputTokenPricePer1M: 4, outputTokenPricePer1M: 20 } });
const proof = (modelRef: string, level: Proof["level"]): Proof => ({ modelRef, level, label: LEVEL_LABEL[level], chainVerified: false, checkedAt: 0, reports: [], notVerified: [] });

describe("auto model in the app", () => {
  it("lists every TEE route of a curated model, cheapest first", () => {
    expect(routesByPrice([tinfoil, near, phala], "kimi-k3")).toEqual([near, tinfoil]);
  });

  it("offers one Auto entry per curated model that some TEE provider serves, with its routes", () => {
    const auto = autoModels([tinfoil, near, phala]);
    expect(auto).toHaveLength(1);
    expect(auto[0]).toMatchObject({ provider: "auto", id: "kimi-k3", name: "Auto · Kimi K3", tee: true, selectable: true });
    expect(auto[0].routes).toEqual(["near:moonshotai/kimi-k3", "tinfoil:kimi-k3"]);
    expect(autoModels([])).toEqual([]);
    // Names come from whichever provider is cheapest; the vendor prefix some providers add is dropped.
    expect(autoModels([{ ...near, name: "MoonshotAI: Kimi K3" }])[0].name).toBe("Auto · Kimi K3");
    // The picker's modality icons come from the cheapest route.
    const vision = { in: ["text", "image"], out: ["text"] };
    expect(autoModels([{ ...near, modalities: vision }])[0].modalities).toEqual(vision);
  });

  it("Auto is the default when it is offered; manual picks stay NEAR-only", () => {
    const all = [tinfoil, near, phala];
    expect(defaultModelRef([...autoModels(all), ...visibleModels(all)])).toBe("auto:kimi-k3");
    expect(visibleModels(all).map((m) => m.provider)).toEqual(["near"]);
  });

  it("the closed picker says the selection is Auto", () => {
    const html = renderToStaticMarkup(<ModelPicker models={autoModels([near])} value="auto:kimi-k3" onChange={() => {}} />);
    expect(html).toContain("Auto · Kimi K3");
  });

  it("uses the cheapest route whose proof holds, skipping failed or missing ones", async () => {
    const levels: Record<string, Proof["level"]> = { a: "unavailable", b: "failed", c: "checks-passed", d: "checks-passed" };
    const tried: string[] = [];
    const got = await firstPassing(["a", "b", "c", "d"], async (r) => { tried.push(r); return proof(r, levels[r]); });
    expect(got?.modelRef).toBe("c");
    expect(tried).toEqual(["a", "b", "c"]);
    expect(await firstPassing(["a", "b"], async (r) => proof(r, levels[r]))).toBeUndefined();
    expect(await firstPassing(["g"], async (r) => proof(r, "gateway-checked"))).toBeUndefined(); // a gateway alone never wins Auto
  });

  it("Tinfoil passes only when our server's SDK check passed, so a broken Tinfoil route lets Auto fall through", async () => {
    expect(sdkProof("tinfoil:kimi-k3", { server_checked: true }).level).toBe("server-checked");
    for (const body of [{}, null, { server_checked: "true" }, { model_attestations: [] }]) expect(sdkProof("tinfoil:kimi-k3", body).level).toBe("unavailable");
    const got = await firstPassing(["tinfoil:kimi-k3", "phala:kimi"], async (r) => (r.startsWith("tinfoil:") ? sdkProof(r, {}) : proof(r, "checks-passed")));
    expect(got?.modelRef).toBe("phala:kimi");
  });

  it("Tinfoil says who checked it and never claims Verified", () => {
    const p = serverCheckedProof("tinfoil:kimi-k3");
    expect(p).toMatchObject({ level: "server-checked", chainVerified: false, modelRef: "tinfoil:kimi-k3" });
    expect(p.label).toBe("Checked by our server · Tinfoil SDK");
    const html = renderToStaticMarkup(<ProofBadge proof={p} onOpen={() => {}} />);
    expect(html).not.toContain("Verified");
    expect(html).toContain("Server-checked");
  });

  it("the welcome line names the provider the chat is sent to, never a hardcoded one", () => {
    expect(enclaveLine("phala:z-ai/glm-5.3")).toBe("Runs inside an attested enclave on Phala Confidential AI.");
    expect(enclaveLine("near:x")).toBe("Runs inside an attested enclave on NEAR AI Cloud.");
    expect(enclaveLine("")).toBe("Runs inside an attested enclave.");
  });

  it("Privatemode is server-checked by its own SDK; unknown or inherited provider names are not", () => {
    const p = serverCheckedProof("privatemode:glm-5.3");
    expect(p).toMatchObject({ level: "server-checked", chainVerified: false, label: "Checked by our server · Privatemode SDK" });
    expect(p.notVerified[0]).toContain("Privatemode SDK on our server");
    expect(isServerChecked("privatemode:glm-5.3")).toBe(true);
    expect(isServerChecked("near:x")).toBe(false);
    expect(isServerChecked("__proto__:x")).toBe(false);
    expect(enclaveLine("privatemode:glm-5.3")).toBe("Runs inside an attested enclave on Privatemode.");
  });

  it("a server-checked proof counts as passing for Auto", async () => {
    expect((await firstPassing(["tinfoil:kimi-k3"], async (r) => serverCheckedProof(r)))?.level).toBe("server-checked");
  });

  it("a gateway-only provider is never described as running the model inside an attested enclave", () => {
    expect(enclaveLine("redpill:qwen/qwen3")).toBe("Runs behind RedPill's attested gateway; the model itself is not attested.");
    expect(enclaveLine("near:m")).toBe("Runs inside an attested enclave on NEAR AI Cloud.");
  });

  it("Auto tries its routes cheapest first, then NEAR's default model, and skips a route whose chat just failed", () => {
    const routes = ["phala:z-ai/glm-5.3", "tinfoil:glm-5-3"];
    expect(autoCandidates(routes, "near:deepseek/deepseek-v4.1-flash", {})).toEqual([...routes, "near:deepseek/deepseek-v4.1-flash"]);
    // The NEAR route is not tried twice when it is already one of Auto's routes.
    expect(autoCandidates(["near:moonshotai/kimi-k3", "tinfoil:kimi-k3"], "near:moonshotai/kimi-k3", {})).toEqual(["near:moonshotai/kimi-k3", "tinfoil:kimi-k3"]);
    const now = 1_000_000;
    const failed = { "phala:z-ai/glm-5.3": now - 1_000, "tinfoil:glm-5-3": now - ROUTE_COOLDOWN_MS };
    expect(autoCandidates(routes, "near:x", failed, now)).toEqual(["tinfoil:glm-5-3", "near:x"]); // tinfoil's cooldown is over
    expect(autoCandidates(routes, undefined, { ...failed, "tinfoil:glm-5-3": now }, now)).toEqual([]);
    // A check that ends after its winner was benched discards it, whether or not NEAR is still available.
    expect(isBenched("phala:z-ai/glm-5.3", failed, now)).toBe(true);
    expect(isBenched("tinfoil:glm-5-3", failed, now)).toBe(false);
    expect(isBenched("near:x", failed, now)).toBe(false);
  });

  it("knows when Auto is on the NEAR fallback, when the hand-off may send by itself, and when to check again", () => {
    const routes = ["phala:glm", "tinfoil:glm"];
    expect(fallbackOf(routes, proof("tinfoil:glm", "server-checked"))).toBe("");
    expect(fallbackOf(routes, proof("near:ds", "checks-passed"))).toBe("near:ds");
    expect(fallbackOf(routes, proof("auto:glm", "unavailable"))).toBe("");
    expect(fallbackOf(undefined, proof("near:ds", "checks-passed"))).toBe(""); // not an Auto selection

    for (const level of ["verified", "checks-passed", "server-checked"] as const) expect(handoffReady(proof("near:m", level), "")).toBe(true);
    for (const level of ["gateway-checked", "failed", "unavailable", "pending"] as const) expect(handoffReady(proof("near:m", level), "")).toBe(false);
    expect(handoffReady(proof("venice:m", "no-enclave"), "")).toBe(true); // an anonymized model picked by hand
    expect(handoffReady(proof("near:ds", "checks-passed"), "near:ds")).toBe(false); // a model the user did not pick: prefill only
    expect(handoffReady(null, "")).toBe(false);

    expect(autoRetryDelay(proof("auto:glm", "unavailable"), routes, 30_000)).toBe(30_000);
    expect(autoRetryDelay(proof("near:ds", "checks-passed"), routes, 30_000)).toBe(ROUTE_COOLDOWN_MS); // NEAR fallback
    expect(autoRetryDelay(proof("tinfoil:glm", "server-checked"), routes, 30_000)).toBe(ROUTE_COOLDOWN_MS); // not the cheapest route
    expect(autoRetryDelay(proof("phala:glm", "checks-passed"), routes, 30_000)).toBe(0); // on the cheapest route
    expect(autoRetryDelay(undefined, routes, 30_000)).toBe(0);
  });

  it("an Auto entry must carry its routes", () => {
    const auto = autoModels([tinfoil, near]);
    expect(autoEntryOf(auto, "auto:kimi-k3")?.routes).toEqual(["near:moonshotai/kimi-k3", "tinfoil:kimi-k3"]);
    expect(autoEntryOf([{ ...near, provider: "auto", id: "kimi-k3" }], "auto:kimi-k3")).toBeUndefined();
    expect(autoEntryOf(auto, "near:moonshotai/kimi-k3")).toBeUndefined();
  });
});
