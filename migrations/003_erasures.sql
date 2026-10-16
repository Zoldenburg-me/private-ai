-- Erasure ledger: one row per account deleted on request, so a restore from backup can delete it
-- again (scripts/reerase.sql). id_hash is sha256 of the random account id; nothing else is kept.
-- Pruned after ERASURE_LEDGER_DAYS (lib/store/types.ts), longer than the oldest backup is kept.
CREATE TABLE erasures (
  id_hash     text PRIMARY KEY,
  deleted_on  date NOT NULL
);
