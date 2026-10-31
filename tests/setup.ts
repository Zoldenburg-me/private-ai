import { DEFS } from "../lib/providers";

// Tests set the provider env they need; a key or URL from the developer's shell must not change the outcome.
for (const { prefix } of DEFS) for (const k of ["API_KEY", "BASE_URL", "MODELS", "MODEL"]) delete process.env[`${prefix}_${k}`];
