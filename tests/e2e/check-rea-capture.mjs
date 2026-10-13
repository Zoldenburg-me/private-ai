import { readFileSync } from "node:fs";
const n = JSON.parse(readFileSync(process.argv[2], "utf8")).normalized_result;
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const bad = n.steps.filter((s) => s.status !== "completed");
if (bad.length) fail("steps not completed: " + bad.map((s) => `${s.step_id}(${s.error})`).join(", "));
const reqs = new Map();
for (const e of n.events.items) if (e.method) reqs.set(e.transaction_id, [e.method, e.url.url.split("?")[0]]);
const origins = new Set([...reqs.values()].map(([, u]) => new URL(u).origin));
if (origins.size !== 1) fail("contacted other origins: " + [...origins].join(", "));
const canary = [];
for (const e of n.events.items) {
  if (e.kind !== "network-content" || e.body?.state !== "captured") continue;
  const t = e.body.encoding === "base64" ? Buffer.from(e.body.content, "base64").toString("utf8") : String(e.body.content);
  if (t.includes("REA-CANARY")) canary.push(reqs.get(e.transaction_id).join(" "));
}
const allowed = canary.every((c) => /^POST .*\/api\/chat$/.test(c));
if (!canary.length || !allowed) fail("canary prompt seen in: " + JSON.stringify(canary));
const keys = [...JSON.stringify(n.steps).matchAll(/"name": ?"([^"]+)"/g)].map((m) => m[1]).filter((k) => k.startsWith("pai."));
console.log(process.exitCode ? "REA CHECK FAILED" : `REA CHECK OK - origins ${[...origins]}, canary only in ${canary}, storage keys ${[...new Set(keys)]}`);
