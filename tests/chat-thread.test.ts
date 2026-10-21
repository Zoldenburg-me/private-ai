import { describe, it, expect } from "vitest";
import { SIG, incognitoLine, replyView, turnToStore } from "@/components/app/ChatThread";

describe("assistant reply bubble", () => {
  it("offers Try again only on the last reply, so a retry never drops later messages", () => {
    expect(replyView("Hi", false, true).retry).toBe(true);
    expect(replyView("Hi", false, false).retry).toBe(false);
    expect(replyView("Hi", true, true).retry).toBe(false);
    expect(replyView("Hi", false, false).copy).toBe(true);
  });

  it("shows Writing… only while running; an empty finished reply says so and can be retried", () => {
    expect(replyView("", true, true).body).toBe("writing");
    expect(replyView("", false, true)).toEqual({ body: "empty", copy: false, retry: true, sig: false });
    expect(replyView("", false, false).retry).toBe(false);
    expect(replyView("x", false, true).body).toBe("text");
  });
});

describe("stored turn", () => {
  const stored = [{ role: "user" as const, content: "q" }];
  it("never stores an empty assistant message, but keeps the submitted prompt", () => {
    expect(turnToStore(stored, "")).toEqual(stored);
    expect(turnToStore(stored, "", "enclave", "anonymized")).toEqual(stored);
  });
  it("stores which incognito route a reply came from, so later model switches do not relabel it", () => {
    expect(turnToStore(stored, "a", undefined, "anonymized")).toEqual([...stored, { role: "assistant", content: "a", incognito: "anonymized" }]);
  });
  it("appends the reply and its signature", () => {
    expect(turnToStore(stored, "a", "enclave")).toEqual([...stored, { role: "assistant", content: "a", signed: "enclave" }]);
    expect(turnToStore(stored, "a")).toEqual([...stored, { role: "assistant", content: "a" }]);
  });
});

describe("incognito line", () => {
  it("comes from the reply's own route; replies without one (enclave or older history) show none", () => {
    expect(incognitoLine("private")).toBe("Incognito · zero-retention");
    expect(incognitoLine("anonymized")).toBe("Incognito · anonymized");
    expect(incognitoLine(undefined)).toBeUndefined();
  });
});

describe("signature line under a reply", () => {
  it("says why there is no signature", () => {
    expect(SIG.server.text).toMatch(/No per-reply signature from this provider · enclave checked by our server/);
    expect(SIG.gateway.text).toMatch(/gateway/);
    for (const s of Object.values(SIG)) expect(s.text).not.toMatch(/^Signature not available$/);
  });
});
