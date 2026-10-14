import type { AccountStore, CounterStore } from "./types";
import { MemoryAccountStore, MemoryCounterStore } from "./memory";

export type * from "./types";
export { ENTITLED_STATUSES } from "./types";

/** Thrown when a configured backend is unreachable. Routes turn it into 503 (fail closed). */
export class StoreUnavailableError extends Error {
  constructor(what: string) { super(`${what} unavailable`); this.name = "StoreUnavailableError"; }
}
export const isUnavailable = (e: unknown): e is StoreUnavailableError => e instanceof Error && e.name === "StoreUnavailableError";

export interface Stores {
  accounts: AccountStore; counters: CounterStore;
  kind: { accounts: "postgres" | "memory" | "unconfigured"; counters: "redis" | "memory" | "unconfigured" };
}

/** Postgres constraint violations are caller errors, not outages. */
const isLogicError = (e: unknown) => {
  const x = e as { severity?: unknown; code?: unknown };
  return typeof x?.severity === "string" && typeof x.code === "string" && x.code.startsWith("23");
};

/** Wrap every async method so backend failures surface as StoreUnavailableError (no detail leaks). */
export function guarded<T extends object>(what: string, target: T): T {
  return new Proxy(target, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv);
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        try { return await v.apply(t, args); } catch (e) {
          if (isLogicError(e) || isUnavailable(e)) throw e;
          throw new StoreUnavailableError(what);
        }
      };
    },
  });
}

function unconfigured<T extends object>(what: string): T {
  return new Proxy({}, { get: () => async () => { throw new StoreUnavailableError(`${what} (not configured)`); } }) as T;
}

export async function createStores(env: Record<string, string | undefined> = process.env): Promise<Stores> {
  // In production an unset URL must not silently fall back to per-process memory.
  const memoryOk = env.NODE_ENV !== "production" || env.PAI_ALLOW_MEMORY_STORE === "1";
  let accounts: AccountStore; let counters: CounterStore; const kind = {} as Stores["kind"];
  if (env.DATABASE_URL) {
    const { PgAccountStore } = await import("./postgres");
    accounts = guarded("database", PgAccountStore.fromUrl(env.DATABASE_URL)); kind.accounts = "postgres";
  } else if (memoryOk) { accounts = new MemoryAccountStore(); kind.accounts = "memory"; }
  else { accounts = unconfigured("database"); kind.accounts = "unconfigured"; }
  if (env.REDIS_URL) {
    const { RedisCounterStore } = await import("./redis");
    counters = guarded("redis", RedisCounterStore.fromUrl(env.REDIS_URL)); kind.counters = "redis";
  } else if (memoryOk) { counters = new MemoryCounterStore(); kind.counters = "memory"; }
  else { counters = unconfigured("redis"); kind.counters = "unconfigured"; }
  return { accounts, counters, kind };
}

// Shared via globalThis: Next bundles each route separately; module state would be per-route.
const g = globalThis as unknown as { __paiStores?: Promise<Stores> };
export function stores(): Promise<Stores> { return (g.__paiStores ??= createStores()); }

/** Tests: install specific stores (default: fresh in-memory). */
export function _setStores(s?: Partial<Stores>): Stores {
  const full: Stores = {
    accounts: s?.accounts ?? new MemoryAccountStore(), counters: s?.counters ?? new MemoryCounterStore(),
    kind: s?.kind ?? { accounts: "memory", counters: "memory" },
  };
  g.__paiStores = Promise.resolve(full); return full;
}

export const unavailableResponse = () =>
  Response.json({ error: { message: "service temporarily unavailable" } }, { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } });

/** Route wrapper: fail closed with 503 when a configured backend is down. */
export function withStores<A extends unknown[]>(fn: (...a: A) => Promise<Response>) {
  return async (...a: A): Promise<Response> => {
    try { return await fn(...a); } catch (e) { if (isUnavailable(e)) return unavailableResponse(); throw e; }
  };
}
