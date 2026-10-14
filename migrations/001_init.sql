-- private-ai initial schema. Stores ONLY opaque ids, tiers, timestamps and Stripe ids.
-- No chat content, no IP addresses, no user agents, no email, no card data.

-- One row per anonymous account. `id` is the random opaque id inside the session token.
CREATE TABLE sessions (
  id            text PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_on  date        NOT NULL DEFAULT current_date
);

CREATE TABLE entitlements (
  account_id  text PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  tier        text NOT NULL CHECK (tier IN ('free', 'pro', 'max')),
  source      text NOT NULL CHECK (source IN ('stripe', 'manual')),
  expires_at  timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  stripe_subscription_id  text PRIMARY KEY,
  account_id              text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  stripe_customer_id      text NOT NULL,
  tier                    text NOT NULL CHECK (tier IN ('free', 'pro', 'max')),
  status                  text NOT NULL,
  current_period_end      timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_account_idx ON subscriptions (account_id, updated_at DESC);
CREATE INDEX subscriptions_customer_idx ON subscriptions (stripe_customer_id);

CREATE TABLE passkey_credentials (
  credential_id  text PRIMARY KEY,
  account_id     text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  public_key     bytea  NOT NULL,
  counter        bigint NOT NULL DEFAULT 0,
  transports     text[] NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX passkey_credentials_account_idx ON passkey_credentials (account_id);
