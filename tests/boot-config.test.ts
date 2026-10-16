import { describe, it, expect } from "vitest";
import { assertProductionConfig } from "../lib/session";

const SECRET = "x".repeat(32);
describe("production boot checks", () => {
  it("refuse a missing or short SESSION_SECRET", () => {
    expect(() => assertProductionConfig({ NODE_ENV: "production" })).toThrow(/SESSION_SECRET/);
    expect(() => assertProductionConfig({ NODE_ENV: "production", SESSION_SECRET: "x".repeat(31) })).toThrow(/SESSION_SECRET/);
    expect(() => assertProductionConfig({ NODE_ENV: "production", SESSION_SECRET: SECRET })).not.toThrow();
  });
  it("refuse the mock enclave unless explicitly allowed for a local e2e run", () => {
    expect(() => assertProductionConfig({ NODE_ENV: "production", SESSION_SECRET: SECRET, MOCK_PROVIDER: "1" })).toThrow(/MOCK_PROVIDER/);
    expect(() => assertProductionConfig({ NODE_ENV: "production", SESSION_SECRET: SECRET, MOCK_PROVIDER: "1", PAI_ALLOW_MOCK_PROVIDER: "1" })).not.toThrow();
  });
  it("do nothing outside production", () => {
    expect(() => assertProductionConfig({ NODE_ENV: "development", MOCK_PROVIDER: "1" })).not.toThrow();
  });
});
