import { readFileSync } from "node:fs";
import { DEFS } from "../lib/providers";

// Tests set the env they need; app config from the developer's shell (a provider key, INVITE_ONLY, a Stripe
// key, NODE_ENV=production, ...) must not change the outcome. .env.example lists the config; DEFS and PAI_* cover
// names built at runtime. tests/env-isolation.test.ts fails when the app reads a name this misses.
const example = [...readFileSync(new URL("../.env.example", import.meta.url), "utf8").matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
const providers = DEFS.flatMap(({ prefix }) => ["API_KEY", "BASE_URL", "MODELS", "MODEL"].map((k) => `${prefix}_${k}`));
export const isCleared = (k: string) => k === "NODE_ENV" || k.startsWith("PAI_") || example.includes(k) || providers.includes(k);

for (const k of Object.keys(process.env)) if (isCleared(k)) delete process.env[k];
Object.assign(process.env, { NODE_ENV: "test" });
