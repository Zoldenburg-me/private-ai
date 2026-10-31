import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isCleared } from "./setup";

const ROOT = join(__dirname, "..");

function* walk(p: string): Generator<string> {
  if (statSync(p).isDirectory()) for (const name of readdirSync(p)) yield* walk(join(p, name));
  else if (/\.(ts|tsx)$/.test(p)) yield p;
}

describe("tests/setup.ts clears all app config", () => {
  it("every env name the app reads is in .env.example, built from DEFS, or PAI_*", () => {
    const missed = new Set<string>();
    for (const top of ["app", "lib", "components", "middleware.ts"]) {
      for (const file of walk(join(ROOT, top))) {
        const src = readFileSync(file, "utf8");
        // env.X, env?.X, env["X"], and const { X, Y } = process.env; names read through a variable are not seen.
        const names = [...src.matchAll(/\benv(?:\??\.|\[["'`])([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]);
        for (const [, list] of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\.env\b/g))
          for (const [, key] of list.matchAll(/(?:^|,)\s*([A-Z][A-Z0-9_]*)\s*(?=[:=,]|$)/g)) names.push(key);
        for (const name of names) if (!isCleared(name)) missed.add(`${relative(ROOT, file)}: ${name}`);
      }
    }
    expect([...missed]).toEqual([]);
  });

  it("a key or flag from the developer's shell does not reach the tests", () => {
    expect(isCleared("NEAR_AI_API_KEY") && isCleared("BFL_API_KEY") && isCleared("INVITE_ONLY") && isCleared("PAI_LOG")).toBe(true);
    expect(process.env.NODE_ENV).toBe("test");
  });
});
