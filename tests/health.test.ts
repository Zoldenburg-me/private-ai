import { describe, it, expect } from "vitest";
import { _setStores, createStores } from "../lib/store";
import { GET } from "../app/api/health/route";

describe("/api/health", () => {
  it("200 with in-memory stores", async () => {
    _setStores();
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, accounts: { backend: "memory", status: "ok" } });
  });
  it("503 when a configured backend is down, without error details", async () => {
    _setStores(await createStores({ NODE_ENV: "test", DATABASE_URL: "postgres://x:y@127.0.0.1:1/none", REDIS_URL: "redis://127.0.0.1:1" }));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ ok: false, accounts: { backend: "postgres", status: "down" }, counters: { backend: "redis", status: "down" } });
  }, 20_000);
});
