import { stores } from "./store";
import { metaLogger } from "./log";

/** Inactive anonymous accounts (no entitled subscription) are deleted after this many days. */
export const RETENTION_DAYS = 365;

export async function purgeInactive(now = Date.now()): Promise<number> {
  return (await stores()).accounts.purgeInactive(now - RETENTION_DAYS * 86_400_000, now);
}

/** Daily purge in the server process (started from instrumentation.ts). Safe with many instances. */
export function startRetentionJob() {
  const run = () => purgeInactive().then(
    (n) => metaLogger({ event: "retention_purge", status: 200, outputBytes: n }),
    () => metaLogger({ event: "retention_purge_failed", status: 503 }),
  );
  setTimeout(run, 60_000).unref();
  setInterval(run, 86_400_000).unref();
}
