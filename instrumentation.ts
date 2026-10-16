export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") (await import("./lib/session")).assertProductionConfig();
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.PAI_RETENTION_JOB !== "0") {
    const { startRetentionJob } = await import("./lib/retention");
    startRetentionJob();
  }
}
