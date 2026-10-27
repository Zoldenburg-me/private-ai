// Fails `npm run build` if a mock-only key or the test trust root from lib/mock-tee.ts reached the browser
// bundle (.next/static): there a mock enclave could pass the client's attestation checks (docs/e2e-enclave-encryption.md N2b).
// The server bundle carries the mock routes on purpose (off unless MOCK_PROVIDER=1) and is not checked.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The literals that end up in any bundle that includes lib/mock-tee.ts: fixed key hex and the key label. */
export function mockSecrets(file = "lib/mock-tee.ts") {
  return [...readFileSync(file, "utf8").matchAll(/"([0-9a-f]{64}|pai-mock-tee\/)"/g)].map((m) => m[1]);
}

export function findLeaks(dir, secrets) {
  const leaks = [];
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const file = join(e.parentPath, e.name);
    const text = readFileSync(file, "latin1");
    for (const secret of secrets) if (text.includes(secret)) leaks.push({ file, secret });
  }
  return leaks;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const secrets = mockSecrets();
  if (secrets.length < 2) throw new Error("check-test-root: found no mock keys in lib/mock-tee.ts; update the pattern");
  const leaks = findLeaks(".next/static", secrets);
  for (const l of leaks) console.error(`check-test-root: ${l.file} contains a mock-only key from lib/mock-tee.ts`);
  if (leaks.length) process.exit(1);
  console.log(`check-test-root: browser bundle is free of the ${secrets.length} mock keys`);
}
