import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { gate, recordFailure, usage, _reset, ERROR_BUDGET } from "../lib/ratelimit";
import { MemoryCounterStore } from "../lib/store/memory";
import { RedisCounterStore } from "../lib/store/redis";
import type { CounterStore } from "../lib/store";

// The same behaviour must hold for the in-memory store and (when TEST_REDIS_URL is set) Redis.
const redis = process.env.TEST_REDIS_URL ? RedisCounterStore.fromUrl(process.env.TEST_REDIS_URL) : null;
const backends: [string, () => Promise<CounterStore>][] = [["memory", async () => new MemoryCounterStore()]];
if (redis) backends.push(["redis", async () => { await redis._flush(); return redis; }]);
afterAll(async () => { await redis?.close(); });

describe.each(backends)("server-side fair-use gate (%s)", (_name, make) => {
  beforeEach(async () => { _reset({ counters: await make() }); });

  it("enforces free daily limit across minutes and sets headers", async () => {
    let now = Date.UTC(2026, 9, 13, 10);
    for (let i = 0; i < 20; i++) { expect((await gate("u", "free", 10, now)).allowed).toBe(true); now += 15_000; }
    const d = await gate("u", "free", 10, now);
    expect(d).toMatchObject({ allowed: false, status: 429, reason: "daily limit reached" });
    expect(d.headers["x-usage-remaining-daily"]).toBe("0");
    expect(d.headers["x-ratelimit-limit-requests"]).toBe("5");
    expect(await usage("u", "free", now)).toEqual({ usedToday: 20, dailyLimit: 20, remainingToday: 0 });
  });
  it("hit: fixed-window counter per bucket", async () => {
    const { counters } = await (await import("../lib/store")).stores();
    const t = Date.UTC(2026, 9, 13, 10, 0, 5);
    expect(await counters.hit("b1", 2, 60_000, t)).toMatchObject({ allowed: true, count: 1 });
    expect(await counters.hit("b1", 2, 60_000, t + 1)).toMatchObject({ allowed: true, count: 2 });
    const third = await counters.hit("b1", 2, 60_000, t + 2);
    expect(third).toMatchObject({ allowed: false, count: 3 });
    expect(third.resetAt).toBe(Date.UTC(2026, 9, 13, 10, 1));
    expect((await counters.hit("b2", 2, 60_000, t)).allowed).toBe(true); // other bucket independent
    expect((await counters.hit("b1", 2, 60_000, Date.UTC(2026, 9, 13, 10, 1, 1))).allowed).toBe(true); // next window
  });
  it("resets daily counter next day", async () => {
    const now = Date.UTC(2026, 9, 13, 23, 50);
    for (let i = 0; i < 20; i++) await gate("u", "free", 1, now + i * 13_000);
    expect((await gate("u", "free", 1, now + 21 * 13_000)).reason).toBe("daily limit reached");
    expect((await gate("u", "free", 1, Date.UTC(2026, 9, 14, 1))).allowed).toBe(true);
  });
  it("enforces per-minute rate with retry-after", async () => {
    const now = Date.UTC(2026, 9, 13, 10);
    for (let i = 0; i < 5; i++) await gate("u", "free", 1, now);
    const d = await gate("u", "free", 1, now + 1000);
    expect(d.status).toBe(429); expect(d.headers["retry-after"]).toBe("59");
    expect((await gate("u", "free", 1, now + 60_000)).allowed).toBe(true);
  });
  it("incognito has its own daily count but shares the minute window and error budget", async () => {
    const now = Date.UTC(2026, 9, 13, 10);
    for (let i = 0; i < 5; i++) await gate("u", "free", 1, now);
    const d = await gate("u", "free", 1, now + 1000, true);
    expect(d.reason).toBe("rate limit, slow down");
    expect(d.headers["x-usage-quota"]).toBe("incognito");
    expect((await gate("u", "free", 1, now + 60_000, true)).headers["x-usage-remaining-daily"]).toBe("49");
    expect(await usage("u", "free", now + 60_000)).toMatchObject({ usedToday: 5, dailyLimit: 20 });
    expect(await usage("u", "free", now + 60_000, true)).toMatchObject({ usedToday: 1, dailyLimit: 50 });
    for (let i = 0; i < ERROR_BUDGET.failures; i++) await recordFailure("u", now + 61_000);
    expect((await gate("u", "free", 1, now + 62_000, true)).reason).toMatch(/error budget/);
  });
  it("enforces context by tier without consuming quota", async () => {
    const now = Date.UTC(2026, 9, 13, 10);
    expect((await gate("a", "free", 9000, now)).status).toBe(413);
    expect(await usage("a", "free", now)).toMatchObject({ usedToday: 0 });
    expect((await gate("b", "pro", 9000, now)).allowed).toBe(true);
  });
  it("error budget blocks after repeated failures, then recovers", async () => {
    const now = Date.UTC(2026, 9, 13, 10);
    for (let i = 0; i < ERROR_BUDGET.failures; i++) await recordFailure("k", now);
    const d = await gate("k", "max", 1, now + 1);
    expect(d.reason).toMatch(/error budget/); expect(d.headers["retry-after"]).toBe("30");
    expect((await gate("k", "max", 1, now + ERROR_BUDGET.windowMs + 1)).allowed).toBe(true);
  });
  it("is atomic under concurrency: never exceeds the per-minute limit", async () => {
    const now = Date.UTC(2026, 9, 13, 12);
    const results = await Promise.all(Array.from({ length: 25 }, () => gate("c", "free", 1, now)));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });
  it("one-time values are read once and expire", async () => {
    const s = await make();
    await s.putOnce("x", "v", 60_000);
    expect(await s.takeOnce("x")).toBe("v");
    expect(await s.takeOnce("x")).toBeNull();
    await s.putOnce("y", "v", 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await s.takeOnce("y")).toBeNull();
  });
});
