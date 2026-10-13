import { describe, it, expect } from "vitest";
import { checkGate } from "../lib/tiers";
describe("tier gate", () => {
  it("enforces daily limit", () => {
    expect(checkGate("free", 19, 10).allowed).toBe(true);
    expect(checkGate("free", 20, 10)).toMatchObject({ allowed: false, reason: "daily limit reached" });
    expect(checkGate("max", 1e9, 10).allowed).toBe(true);
  });
  it("enforces context", () => {
    expect(checkGate("free", 0, 9000).allowed).toBe(false);
    expect(checkGate("pro", 0, 9000).allowed).toBe(true);
  });
});
