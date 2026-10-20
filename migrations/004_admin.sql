-- Admin panel. No chat content, IP addresses, user agents or emails here either.

-- Provider API keys, AES-256-GCM encrypted with ADMIN_KEY_KEK (env only, never in the database).
-- `suffix` is the last 4 characters, shown so admins can tell keys apart.
CREATE TABLE provider_keys (
  id            text PRIMARY KEY,
  provider      text NOT NULL,
  ciphertext    bytea NOT NULL,
  suffix        text NOT NULL,
  status        text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz,
  last_used_at  timestamptz
);
CREATE UNIQUE INDEX provider_keys_one_active ON provider_keys (provider) WHERE status = 'active';

-- Who (admin account id) did what, when, to which target. A user's account id is cleared
-- when that account is deleted (ON DELETE SET NULL); deletions record only the erasure hash.
CREATE TABLE admin_audit (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  admin_id    text NOT NULL,
  action      text NOT NULL,
  account_id  text REFERENCES sessions(id) ON DELETE SET NULL,
  target      text,
  detail      text
);
CREATE INDEX admin_audit_at_idx ON admin_audit (at DESC);
-- Account deletions (ON DELETE SET NULL) look up their rows here instead of scanning the log.
CREATE INDEX admin_audit_account_idx ON admin_audit (account_id) WHERE account_id IS NOT NULL;

-- Invite codes created in the admin panel, alongside the INVITE_CODES env codes. Only the hash is kept.
CREATE TABLE invite_codes (
  id          text PRIMARY KEY,
  code_hash   text NOT NULL UNIQUE,
  max_uses    integer NOT NULL CHECK (max_uses > 0),
  uses        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
