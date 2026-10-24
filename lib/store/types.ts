import { createHash } from "node:crypto";
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

/** One row of the admin account list. `tier` is the stored, unexpired entitlement, null if none. */
export interface AccountSummary { id: string; createdAt: number; lastSeenOn: string; tier: TierId | null }

export type ProviderKeyStatus = "active" | "disabled";
/** Provider key metadata. The ciphertext never leaves the store except via activeProviderKeys(). */
export interface ProviderKeyInfo {
  id: string; provider: string; suffix: string; status: ProviderKeyStatus;
  createdAt: number; disabledAt: number | null; lastUsedAt: number | null;
}

/** Admin audit entry. `accountId` is cleared when that account is deleted; no IPs, user agents or secrets. */
export interface AuditEntry { id: number; at: number; adminId: string; action: string; accountId: string | null; target: string | null; detail: string | null }
export type NewAuditEntry = { adminId: string; action: string; accountId?: string | null; target?: string | null; detail?: string | null };

/** Invite code row: only the SHA-256 of the code is stored. */
export interface InviteInfo { id: string; maxUses: number; uses: number; createdAt: number; revokedAt: number | null }

/** Durable account data (Postgres in production). */
export interface AccountStore {
  /** Create the session row if missing and bump last-seen (day granularity). */
  touchSession(id: string, now?: number): Promise<void>;
  sessionExists(id: string): Promise<boolean>;
  /** Created time and last-seen day, or null if the account has no row. */
  getSession(id: string): Promise<{ createdAt: number; lastSeenOn: string } | null>;
  /**
   * Delete the account row; entitlements, subscriptions and passkeys go with it. False if absent.
   * Also records erasureHash(id) in the erasure ledger, which a backup restore replays.
   */
  deleteAccount(id: string): Promise<boolean>;
  /** The erasure ledger of the last ERASURE_LEDGER_DAYS: deleted accounts, removed devices and passkeys, disabled or deleted provider keys, revoked invites. */
  listErasures(): Promise<{ idHash: string; deletedOn: string }[]>;
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
  /** Delete a passkey only if it belongs to `accountId` and is not its last one (atomic). False otherwise. Ledgered like deleteAccount. */
  deleteCredential(accountId: string, credentialId: string): Promise<boolean>;
  /** Creates the account row if missing. */
  addDevice(d: { id: string; accountId: string; createdAt: number }): Promise<void>;
  /** True if the device exists for that account; bumps its last-seen day. */
  touchDevice(accountId: string, id: string, now?: number): Promise<boolean>;
  listDevices(accountId: string): Promise<Device[]>;
  /** Delete a device only if it belongs to `accountId`. False if not found for that account. Ledgered like deleteAccount. */
  deleteDevice(accountId: string, id: string): Promise<boolean>;
  /** True once the account has a passkey or a signed-in device (account-only tokens stop working). */
  hasSignIn(accountId: string): Promise<boolean>;
  /**
   * Delete accounts last seen before `cutoff` that have no entitled subscription. A subscription
   * still marked active whose period ended before `cutoff` (missed renewal webhooks) does not
   * protect the account. Returns count. Purged accounts are not ledgered: after a restore this
   * purge deletes them again. Also prunes ledger entries older than ERASURE_LEDGER_DAYS before `now`.
   */
  purgeInactive(cutoff: number, now?: number): Promise<number>;

  /** Admin: accounts whose id starts with `prefix` (literal), newest first. */
  listAccounts(q: { prefix: string; limit: number; offset: number }): Promise<AccountSummary[]>;
  /** Admin: store an encrypted provider key as the provider's active key; the previous active one is disabled (atomic). */
  addProviderKey(k: { id: string; provider: string; ciphertext: Uint8Array; suffix: string; createdAt: number }): Promise<void>;
  listProviderKeys(): Promise<ProviderKeyInfo[]>;
  /** Active keys with their ciphertext, for building provider requests only. */
  activeProviderKeys(): Promise<{ id: string; provider: string; ciphertext: Uint8Array }[]>;
  /** Activating a key disables the provider's other active key (atomic). False if the key does not exist. Disabling is ledgered like deleteAccount (re-enabling keeps the entry). */
  setProviderKeyStatus(id: string, status: ProviderKeyStatus): Promise<boolean>;
  /** Ledgered like deleteAccount. */
  deleteProviderKey(id: string): Promise<boolean>;
  markProviderKeyUsed(id: string, now: number): Promise<void>;
  addAudit(e: NewAuditEntry): Promise<void>;
  listAudit(limit: number): Promise<AuditEntry[]>;
  addInvite(i: { id: string; codeHash: string; maxUses: number; createdAt: number }): Promise<void>;
  listInvites(): Promise<InviteInfo[]>;
  /** True if the code exists, is not revoked and has uses left (nothing is counted). */
  inviteUsable(codeHash: string): Promise<boolean>;
  /** Count one use of the code if it exists, is not revoked and has uses left (atomic). */
  redeemInvite(codeHash: string): Promise<boolean>;
  /** Give back one use counted by redeemInvite (the signup it was for failed). */
  releaseInvite(codeHash: string): Promise<void>;
  /** Ledgered like deleteAccount. */
  revokeInvite(id: string): Promise<boolean>;
  ping(): Promise<void>;
}

/** Audit entries older than this are pruned by the retention job. */
export const AUDIT_LOG_DAYS = 365;

/** Subscription states that grant access (Stripe retries failed renewals while past_due). */
export const ENTITLED_STATUSES = ["active", "trialing", "past_due"] as const;

/** `scope` keeps a separate daily count (e.g. "incognito"); the minute window and error budget stay per id. */
export interface ConsumeLimits { daily: number; perMinute: number; budgetFailures: number; budgetWindowMs: number; scope?: QuotaScope }
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
  usedToday(id: string, now: number, scope?: QuotaScope): Promise<number>;
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

export type QuotaScope = "incognito";
/** Suffix of the daily counter after the id: ":<scope>:<day>" or ":<day>". */
export const dailySuffix = (now: number, scope?: QuotaScope) => `${scope ? `:${scope}` : ""}:${dayKey(now)}`;

/** Erasure ledger entries outlive the oldest backup (3 months, docs/backup-restore.md) with margin. */
export const ERASURE_LEDGER_DAYS = 120;
/** Ledger key of a deleted account. Account ids are 128-bit random, so the hash cannot be reversed. */
export const erasureHash = (id: string) => createHash("sha256").update(id, "utf8").digest("hex");
export const minuteStartOf = (now: number) => Math.floor(now / 60_000) * 60_000;
