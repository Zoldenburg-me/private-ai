-- Plus plan and frontier credits. Amounts in micro-euros (1 EUR = 1,000,000). Still no content, card data or IPs.

ALTER TABLE entitlements DROP CONSTRAINT entitlements_tier_check;
ALTER TABLE entitlements ADD CONSTRAINT entitlements_tier_check CHECK (tier IN ('free', 'plus', 'pro', 'max'));
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_tier_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_tier_check CHECK (tier IN ('free', 'plus', 'pro', 'max'));

-- Bought credits never expire; the plan's included credits reset each calendar month (UTC).
CREATE TABLE credits (
  account_id        text PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  purchased_micros  bigint NOT NULL DEFAULT 0,
  included_micros   bigint NOT NULL DEFAULT 0,
  included_month    text   NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One row per paid top-up, so a replayed Stripe webhook never credits twice.
CREATE TABLE credit_topups (
  stripe_session_id  text PRIMARY KEY,
  account_id         text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  micros             bigint NOT NULL CHECK (micros > 0),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_topups_account_idx ON credit_topups (account_id);
