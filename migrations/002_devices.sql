-- Signed-in browsers of an account. One row per device token; deleting the row signs that
-- device out. Opaque ids and day-granularity timestamps only: no names, user agents or IPs.
CREATE TABLE devices (
  id            text PRIMARY KEY,
  account_id    text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_on  date        NOT NULL DEFAULT current_date
);
CREATE INDEX devices_account_idx ON devices (account_id);
