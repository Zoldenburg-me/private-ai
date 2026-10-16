import type { TierId } from "../tiers";

/**
 * Persistence interfaces. Only opaque ids, tiers, timestamps and counters cross these
 * boundaries: never chat content, IP addresses or user agents.
 */

export type EntitlementSource = "stripe" | "manual";
export interface Entitlement { tier: TierId; source: EntitlementSource; expiresAt: number | null }

export interface Subscription {
  stripeSubscriptionId: string; accountId: string; stripeCustomerId: string;
  tier: TierId; status: string; currentPeriodEnd: number | null;
}

export interface PasskeyCredential {
  credentialId: string; accountId: string; publicKey: Uint8Array; counter: number;
  transports: string[]; createdAt: number;
}

/** A signed-in browser. Deleting it revokes that browser's token. */
export interface Device { id: string; accountId: string; createdAt: number; lastSeenOn: string }

/** Durable account data (Postgres in production). */
export interface AccountStore {
  /** Create the session row if missing and bump last-seen (day granularity). */
  touchSession(id: string, now?: number): Promise<void>;
  sessionExists(id: string): Promise<boolean>;
  /** Created time and last-seen day, or null if the account has no row. */
  getSession(id: string): Promise<{ createdAt: number; lastSeenOn: string } | null>;
  /** Delete the account row; entitlements, subscriptions and passkeys go with it. False if absent. */
  deleteAccount(id: string): Promise<boolean>;
  getEntitlement(id: string): Promise<Entitlement | null>;
  setEntitlement(id: string, e: Entitlement): Promise<void>;
  /** Remove the entitlement, optionally only if it came from `source`. */
  clearEntitlement(id: string, source?: EntitlementSource): Promise<void>;
  /** With onlyIfAccountExists, nothing is written when the account row is gone (deleted account). */
  upsertSubscription(s: Subscription, opts?: { onlyIfAccountExists?: boolean }): Promise<void>;
  getSubscription(stripeSubscriptionId: string): Promise<Subscription | null>;
  latestSubscriptionFor(accountId: string): Promise<Subscription | null>;
  listSubscriptionsFor(accountId: string): Promise<Subscription[]>;
  addCredential(c: PasskeyCredential): Promise<void>;
  getCredential(credentialId: string): Promise<PasskeyCredential | null>;
  listCredentials(accountId: string): Promise<PasskeyCredential[]>;
  updateCredentialCounter(credentialId: string, counter: number): Promise<void>;
  /** Delete a passkey only if it belongs to `accountId`. False if not found for that account. */
  deleteCredential(accountId: string, credentialId: string): Promise<boolean>;
  /** Creates the account row if missing. */
  addDevice(d: { id: string; accountId: string; createdAt: number }): Promise<void>;
  /** True if the device exists for that account; bumps its last-seen day. */
  touchDevice(accountId: string, id: string, now?: number): Promise<boolean>;
  listDevices(accountId: string): Promise<Device[]>;
  /** Delete a device only if it belongs to `accountId`. False if not found for that account. */
  deleteDevice(accountId: string, id: string): Promise<boolean>;
  /** True once the account has a passkey or a signed-in device (account-only tokens stop working). */
  hasSignIn(accountId: string): Promise<boolean>;
  /**
   * Delete accounts last seen before `cutoff` that have no entitled subscription. A subscription
   * still marked active whose period ended before `cutoff` (missed renewal webhooks) does not
   * protect the account. Returns count.
   */
  purgeInactive(cutoff: number): Promise<number>;
  ping(): Promise<void>;
}

/** Subscription states that grant access (Stripe retries failed renewals while past_due). */
export const ENTITLED_STATUSES = ["active", "trialing", "past_due"] as const;

export interface ConsumeLimits { daily: number; perMinute: number; budgetFailures: number; budgetWindowMs: number }
export type ConsumeOutcome = "ok" | "budget" | "rejected" | "daily" | "minute";
export interface ConsumeResult {
  outcome: ConsumeOutcome;
  /** Counter values after the call. */
  daily: number; minute: number;
  /** Start of the current fixed one-minute window (ms). */
  minuteStart: number;
  /** Oldest failure still inside the error-budget window (ms), 0 if none. */
  oldestFailure: number;
}

/** Fast, expiring counters and one-time values (Redis in production). */
export interface CounterStore {
  /**
   * Atomically: check the error budget, then (if `commit`) the daily and per-minute limits,
   * and increment both counters when allowed. With commit=false nothing is incremented and the
   * outcome is "rejected" unless the error budget fires first.
   */
  consume(id: string, limits: ConsumeLimits, commit: boolean, now: number): Promise<ConsumeResult>;
  recordFailure(id: string, windowMs: number, now: number): Promise<void>;
  usedToday(id: string, now: number): Promise<number>;
  /**
   * Fixed-window request counter for abuse limits (`bucket` is a route name or account id).
   * Always increments; `allowed` is false once the count exceeds `limit` in this window.
   */
  hit(bucket: string, limit: number, windowMs: number, now: number): Promise<HitResult>;
  /** Store a one-time value with a TTL (e.g. a WebAuthn challenge). */
  putOnce(key: string, value: string, ttlMs: number): Promise<void>;
  /** Read and delete atomically; null if missing or expired. */
  takeOnce(key: string): Promise<string | null>;
  ping(): Promise<void>;
}

export interface HitResult { allowed: boolean; count: number; resetAt: number }

export const dayKey = (now: number) => new Date(now).toISOString().slice(0, 10);
export const minuteStartOf = (now: number) => Math.floor(now / 60_000) * 60_000;
