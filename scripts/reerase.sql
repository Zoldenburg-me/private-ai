-- Run by scripts/restore-db.sh on a freshly restored database. Merges the erasure ledger entries in
-- temp table `incoming` (from the live database and the off-site ledger, i.e. deletions made after
-- the snapshot) into `erasures`, then deletes every listed account, device and passkey again. Tested in tests/store.test.ts.
INSERT INTO erasures (id_hash, deleted_on)
  SELECT id_hash, min(deleted_on) FROM incoming GROUP BY id_hash
  ON CONFLICT (id_hash) DO NOTHING;
-- ON DELETE CASCADE removes entitlements, subscriptions, passkeys and devices.
DELETE FROM sessions WHERE encode(sha256(convert_to(id, 'UTF8')), 'hex') IN (SELECT id_hash FROM erasures);
-- Devices signed out and passkeys removed after the snapshot: their tokens and keys stay revoked.
DELETE FROM devices WHERE encode(sha256(convert_to(id, 'UTF8')), 'hex') IN (SELECT id_hash FROM erasures);
DELETE FROM passkey_credentials WHERE encode(sha256(convert_to(credential_id, 'UTF8')), 'hex') IN (SELECT id_hash FROM erasures);
