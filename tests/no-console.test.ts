import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Hard rule: prompts and responses are never logged. The only console call allowed in
 * app/ and lib/ is the metadata-only sink in lib/log.ts, which prints sanitise()d fields.
 */
const ROOT = join(__dirname, "..");
const ALLOWED = new Map([["lib/log.ts", /console\.log\(JSON\.stringify\(\{ t: new Date\(\)\.toISOString\(\), \.\.\.sanitise\(/]]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) yield p;
  }
}

describe("no console.* in app/ and lib/", () => {
  it("only lib/log.ts may write, and only sanitised metadata", () => {
    const offenders: string[] = [];
    for (const dir of ["app", "lib"]) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file).split("\\").join("/");
        readFileSync(file, "utf8").split("\n").forEach((line, i) => {
          if (!/\bconsole\s*\.\s*\w+/.test(line)) return;
          const ok = ALLOWED.get(rel);
          if (!ok || !ok.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
