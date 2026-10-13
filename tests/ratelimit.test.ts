import { describe, it, expect, beforeEach } from "vitest";
import { gate, recordFailure, _reset, ERROR_BUDGET } from "../lib/ratelimit";

beforeEach(() => _reset());
describe("server-side fair-use gate", () => {
  it("enforces free daily limit across minutes and sets headers", () => {
    let now = Date.UTC(2026, 9, 13, 10);
    for (let i = 0; i < 20; i++) { expect(gate("u", "free", 10, now).allowed).toBe(true); now += 15_000; }
    const d = gate("u", "free", 10, now);
    expect(d).toMatchObject({ allowed: false, status: 429, reason: "daily limit reached" });
    expect(d.headers["x-usage-remaining-daily"]).toBe("0");
    expect(d.headers["x-ratelimit-limit-requests"]).toBe("5");
  });
  it("resets daily counter next day", () => {
    const now = Date.UTC(2026, 9, 13, 23, 59);
    for (let i = 0; i < 20; i++) gate("u", "free", 1, now + i * 13_000);
    expect(gate("u", "free", 1, Date.UTC(2026, 9, 14, 1)).allowed).toBe(true);
  });
  it("enforces per-minute rate with retry-after", () => {
    const now = Date.UTC(2026, 9, 13, 10);
    for (let i = 0; i < 5; i++) gate("u", "free", 1, now);
    const d = gate("u", "free", 1, now + 1000);
    expect(d.status).toBe(429); expect(d.headers["retry-after"]).toBeDefined();
  });
  it("enforces context by tier", () => {
    expect(gate("a", "free", 9000).status).toBe(413);
    expect(gate("b", "pro", 9000).allowed).toBe(true);
  });
  it("error budget blocks after repeated failures, then recovers", () => {
    const now = Date.UTC(2026, 9, 13, 10);
    for (let i = 0; i < ERROR_BUDGET.failures; i++) recordFailure("k", now);
    expect(gate("k", "max", 1, now + 1).reason).toMatch(/error budget/);
    expect(gate("k", "max", 1, now + ERROR_BUDGET.windowMs + 1).allowed).toBe(true);
  });
});
