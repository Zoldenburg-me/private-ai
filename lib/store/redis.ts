import Redis from "ioredis";
import type { ConsumeLimits, ConsumeResult, CounterStore, HitResult } from "./types";
import { dayKey, minuteStartOf } from "./types";

/**
 * One atomic round trip per request. Keys use a {id} hash tag so they share a cluster slot.
 * KEYS: daily, minute, failures(zset). ARGV: now, budgetWindowMs, budgetFailures, dailyLimit,
 * minuteLimit, commit, dailyTtlMs, minuteTtlMs.
 */
const CONSUME = `
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - tonumber(ARGV[2]))
local fails = redis.call('ZCARD', KEYS[3])
local oldest = 0
if fails > 0 then oldest = tonumber(redis.call('ZRANGE', KEYS[3], 0, 0, 'WITHSCORES')[2]) end
local daily = tonumber(redis.call('GET', KEYS[1]) or '0')
local minute = tonumber(redis.call('GET', KEYS[2]) or '0')
if fails >= tonumber(ARGV[3]) then return {'budget', daily, minute, oldest} end
if ARGV[6] ~= '1' then return {'rejected', daily, minute, oldest} end
if daily >= tonumber(ARGV[4]) then return {'daily', daily, minute, oldest} end
if minute >= tonumber(ARGV[5]) then return {'minute', daily, minute, oldest} end
daily = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[7])
minute = redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], ARGV[8])
return {'ok', daily, minute, oldest}
`;

/** Fixed-window counter: INCR, set the TTL on the first hit only. KEYS: counter. ARGV: windowMs. */
const HIT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return c
`;

type WithConsume = Redis & {
  paiConsume(...args: (string | number)[]): Promise<[string, number, number, number]>;
  paiHit(key: string, windowMs: number): Promise<number>;
};

export class RedisCounterStore implements CounterStore {
  private r: WithConsume;
  constructor(client: Redis, private prefix = "pai:") {
    client.defineCommand("paiConsume", { numberOfKeys: 3, lua: CONSUME });
    client.defineCommand("paiHit", { numberOfKeys: 1, lua: HIT });
    this.r = client as WithConsume;
  }

  static fromUrl(url: string) {
    // Fail fast instead of queueing forever: the caller turns errors into 503.
    const client = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 3000, enableOfflineQueue: true });
    client.on("error", () => { /* surfaced per command; never logged with payloads */ });
    return new RedisCounterStore(client);
  }

  private k = (kind: string, id: string, suffix = "") => `${this.prefix}${kind}:{${id}}${suffix}`;

  async consume(id: string, l: ConsumeLimits, commit: boolean, now: number): Promise<ConsumeResult> {
    const minuteStart = minuteStartOf(now);
    const [outcome, daily, minute, oldest] = await this.r.paiConsume(
      this.k("d", id, `:${dayKey(now)}`), this.k("m", id, `:${minuteStart}`), this.k("f", id),
      now, l.budgetWindowMs, l.budgetFailures, l.daily, l.perMinute, commit ? "1" : "0", 2 * 86_400_000, 120_000,
    );
    return { outcome: outcome as ConsumeResult["outcome"], daily: Number(daily), minute: Number(minute), minuteStart, oldestFailure: Number(oldest) };
  }
  async recordFailure(id: string, windowMs: number, now: number) {
    const key = this.k("f", id);
    await this.r.multi().zadd(key, now, `${now}:${Math.random().toString(36).slice(2)}`).pexpire(key, windowMs).exec();
  }
  async usedToday(id: string, now: number) { return Number((await this.r.get(this.k("d", id, `:${dayKey(now)}`))) ?? 0); }
  async hit(bucket: string, limit: number, windowMs: number, now: number): Promise<HitResult> {
    const start = Math.floor(now / windowMs) * windowMs;
    const count = Number(await this.r.paiHit(this.k("rl", bucket, `:${start}`), windowMs));
    return { allowed: count <= limit, count, resetAt: start + windowMs };
  }
  async putOnce(key: string, value: string, ttlMs: number) { await this.r.set(`${this.prefix}once:${key}`, value, "PX", ttlMs); }
  async takeOnce(key: string) { return this.r.getdel(`${this.prefix}once:${key}`); }
  async ping() { await this.r.ping(); }
  async close() { this.r.disconnect(); }
  /** Test helper: delete only our keys. */
  async _flush() { const keys = await this.r.keys(`${this.prefix}*`); if (keys.length) await this.r.del(...keys); }
}
