import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { normaliseModel } from "@/lib/catalog";
import { noEnclaveProof, signatureLevel } from "@/lib/client/proof";
import { ENABLED_PROVIDERS, PROVIDER_LABEL, defaultModelRef, visibleModels } from "@/lib/client/providers";
import { ModelPicker } from "@/components/app/ModelPicker";
import { ProofBadge } from "@/components/app/ProofBadge";
import { ProofDrawer } from "@/components/app/ProofDrawer";

const fable = normaliseModel({ id: "venice", privacy: "anon-gateway" }, { id: "claude-fable-5-1", name: "Claude Fable 5.1" });

describe("anonymized frontier models in the UI", () => {
  it("the gateway is enabled client-side and its group is labelled as anonymized frontier models", () => {
    expect(ENABLED_PROVIDERS).toContain("venice");
    expect(PROVIDER_LABEL.venice).toBe("Frontier · anonymized");
    expect(visibleModels([fable])).toEqual([fable]);
  });

  it("an anonymized model is never the default: the user has to pick it", () => {
    const tee = normaliseModel({ id: "near", privacy: "tee-attested" }, { id: "q" });
    expect(defaultModelRef([fable, tee])).toBe("near:q");
    expect(defaultModelRef([fable])).toBe("");
  });

  it("the picker shows the selected frontier model as ANONYMIZED with a plain explanation", () => {
    const html = renderToStaticMarkup(<ModelPicker models={[fable]} value="venice:claude-fable-5-1" onChange={() => {}} />);
    expect(html).toContain("Claude Fable 5.1");
    expect(html).toContain('data-testid="badge-anonymized"');
    expect(html).toContain("ANONYMIZED");
    expect(html).not.toContain("TEE");
    expect(html).toMatch(/leaves the enclave path[^"]*without your identity/);
  });

  it("proof for an anonymized model says no enclave attestation applies, never a TEE or verified state", () => {
    const p = noEnclaveProof("venice:claude-fable-5-1");
    expect(p).toMatchObject({ level: "no-enclave", chainVerified: false, reports: [] });
    expect(p.signingAddress).toBeUndefined();
    expect(p.label).toMatch(/no enclave/i);
    expect(p.label).not.toMatch(/verified|checks passed/i);
    expect(signatureLevel(p, true)).not.toBe("enclave");

    const badge = renderToStaticMarkup(<ProofBadge proof={p} onOpen={() => {}} />);
    expect(badge).toContain('data-level="no-enclave"');
    expect(badge).toMatch(/No enclave/);
    expect(badge).not.toMatch(/chain/i);

    const drawer = renderToStaticMarkup(<ProofDrawer open proof={p} onClose={() => {}} onRecheck={() => {}} />);
    expect(drawer).toMatch(/No enclave attestation applies/);
    expect(drawer).not.toContain("Enclave proof");
    expect(drawer).not.toMatch(/Certificate chain|signing key/i);
  });
});
