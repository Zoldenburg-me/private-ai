// The boot checks' own static messages (lib/session.ts, lib/keyvault.ts). Exact match, so no value can ride along.
const BOOT_CHECK_MESSAGES = new Set([
  "SESSION_SECRET must be at least 32 characters in production",
  "MOCK_PROVIDER=1 is not allowed in production",
  "INVITE_CODES or INVITE_ONLY=1 is required in production",
  "ADMIN_KEY_KEK must be 32 bytes, base64-encoded",
]);

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      (await import("./lib/session")).assertProductionConfig();
    } catch (e) {
      // Next only logs a throwing hook and keeps serving 500s; exit so the container restarts and the
      // operator sees why. Only our own static check messages are printed: any other error's text
      // could carry config values.
      const msg = e instanceof Error ? e.message : "";
      console.error(`boot check failed: ${BOOT_CHECK_MESSAGES.has(msg) ? msg : "unexpected error"}`);
      process.exit(1);
      return;
    }
  }
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.PAI_RETENTION_JOB !== "0") {
    const { startRetentionJob } = await import("./lib/retention");
    startRetentionJob();
  }
}
