import { stores } from "./store";
import { metaLogger } from "./log";

/** Inactive accounts (no entitled subscription) and unused signed-in browsers are deleted after this many days. */
export const RETENTION_DAYS = 365;

export async function purgeInactive(now = Date.now()): Promise<number> {
  const { accounts } = await stores(); const cutoff = now - RETENTION_DAYS * 86_400_000;
  return (await accounts.purgeInactive(cutoff)) + (await accounts.purgeStaleDevices(cutoff));
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
