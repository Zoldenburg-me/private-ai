import { describe, it, expect, vi } from "vitest";
import { register } from "../instrumentation";
import { assertProductionConfig } from "../lib/session";

const SECRET = "x".repeat(32);
const GATE = { INVITE_ONLY: "1" };
describe("production boot checks", () => {
  it("refuse a missing or short SESSION_SECRET", () => {
    expect(() => assertProductionConfig({ NODE_ENV: "production" })).toThrow(/SESSION_SECRET/);
    expect(() => assertProductionConfig({ NODE_ENV: "production", SESSION_SECRET: "x".repeat(31) })).toThrow(/SESSION_SECRET/);
    expect(() => assertProductionConfig({ NODE_ENV: "production", SESSION_SECRET: SECRET, ...GATE })).not.toThrow();
  });
  it("refuse the mock enclave unless explicitly allowed for a local e2e run", () => {
    expect(() => assertProductionConfig({ NODE_ENV: "production", SESSION_SECRET: SECRET, ...GATE, MOCK_PROVIDER: "1" })).toThrow(/MOCK_PROVIDER/);
    expect(() => assertProductionConfig({ NODE_ENV: "production", SESSION_SECRET: SECRET, ...GATE, MOCK_PROVIDER: "1", PAI_ALLOW_MOCK_PROVIDER: "1" })).not.toThrow();
  });
  it("refuse an open signup gate", () => {
    const base = { NODE_ENV: "production", SESSION_SECRET: SECRET };
    expect(() => assertProductionConfig(base)).toThrow(/INVITE_CODES/);
    expect(() => assertProductionConfig({ ...base, INVITE_CODES: " , " })).toThrow(/INVITE_CODES/);
    expect(() => assertProductionConfig({ ...base, INVITE_CODES: "abc" })).not.toThrow();
    expect(() => assertProductionConfig({ ...base, INVITE_ONLY: "1" })).not.toThrow();
  });
  it("do nothing outside production", () => {
    expect(() => assertProductionConfig({ NODE_ENV: "development", MOCK_PROVIDER: "1" })).not.toThrow();
  });
});

describe("instrumentation register()", () => {
  // Next only logs a throwing instrumentation hook and keeps serving 500s; the process must exit instead.
  it("exits the process when a boot check fails", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs"); vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", ""); vi.stubEnv("PAI_RETENTION_JOB", "0");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await register();
      expect(exit).toHaveBeenCalledWith(1);
      expect(String(err.mock.calls[0])).toMatch(/SESSION_SECRET/);
    } finally { exit.mockRestore(); err.mockRestore(); vi.unstubAllEnvs(); }
  });

  it("prints only known boot-check messages, never an unexpected error's text", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.doMock("../lib/session", () => ({ assertProductionConfig: () => { throw new Error("postgres://pai:hunter2@db leaked"); } }));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      await (await import("../instrumentation")).register();
      expect(exit).toHaveBeenCalledWith(1);
      expect(String(err.mock.calls[0])).toBe("boot check failed: unexpected error");
    } finally { vi.doUnmock("../lib/session"); exit.mockRestore(); err.mockRestore(); vi.unstubAllEnvs(); }
  });
});
