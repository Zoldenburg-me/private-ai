-- Run by scripts/restore-db.sh on a freshly restored database. Merges the erasure ledger entries in
-- temp table `incoming` (from the live database and the off-site ledger, i.e. deletions made after
-- the snapshot) into `erasures`, then re-applies every listed deletion and revocation. Tested in tests/store.test.ts.
INSERT INTO erasures (id_hash, deleted_on)
  SELECT id_hash, min(deleted_on) FROM incoming GROUP BY id_hash
  ON CONFLICT (id_hash) DO NOTHING;
-- ON DELETE CASCADE removes entitlements, subscriptions, passkeys and devices.
DELETE FROM sessions WHERE encode(sha256(convert_to(id, 'UTF8')), 'hex') IN (SELECT id_hash FROM erasures);
-- Devices signed out and passkeys removed after the snapshot: their tokens and keys stay revoked.
DELETE FROM devices WHERE encode(sha256(convert_to(id, 'UTF8')), 'hex') IN (SELECT id_hash FROM erasures);
DELETE FROM passkey_credentials WHERE encode(sha256(convert_to(credential_id, 'UTF8')), 'hex') IN (SELECT id_hash FROM erasures);
-- Provider keys disabled or deleted, and invites revoked, after the snapshot. The ledger does not tell a delete
-- from a disable, so a deleted key comes back disabled (delete it again), and a key re-enabled since its
-- disable comes back disabled too (enable it again). Snapshots from before migration 004 lack both tables.
DO $$ BEGIN
  IF to_regclass('provider_keys') IS NOT NULL THEN
    UPDATE provider_keys SET status = 'disabled', disabled_at = COALESCE(disabled_at, now())
      WHERE status = 'active' AND encode(sha256(convert_to(id, 'UTF8')), 'hex') IN (SELECT id_hash FROM erasures);
  END IF;
  IF to_regclass('invite_codes') IS NOT NULL THEN
    UPDATE invite_codes SET revoked_at = COALESCE(revoked_at, now())
      WHERE revoked_at IS NULL AND encode(sha256(convert_to(id, 'UTF8')), 'hex') IN (SELECT id_hash FROM erasures);
  END IF;
END $$;
