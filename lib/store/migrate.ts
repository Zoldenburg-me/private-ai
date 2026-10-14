import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";

export const MIGRATIONS_DIR = () => process.env.PAI_MIGRATIONS_DIR || join(process.cwd(), "migrations");

/** Applies migrations/NNN_*.sql in order, once each, under an advisory lock (safe with many instances). */
export async function migrate(sql: Sql, dir = MIGRATIONS_DIR()): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(72716101)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Set((await tx<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      await tx.unsafe(readFileSync(join(dir, f), "utf8"));
      await tx`INSERT INTO schema_migrations (name) VALUES (${f})`;
      applied.push(f);
    }
  });
  return applied;
}
