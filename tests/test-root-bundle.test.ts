import { describe, it, expect } from "vitest";
import { build } from "esbuild";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain .mjs build script, no types
import { mockSecrets, findLeaks } from "../scripts/check-test-root.mjs";

describe("test trust root stays out of the browser bundle", () => {
  it("knows every fixed mock key in lib/mock-tee.ts", () => {
    const secrets: string[] = mockSecrets();
    expect(secrets).toContain("pai-mock-tee/"); // the label every E2EE test key and the test root derive from
    expect(secrets.length).toBeGreaterThanOrEqual(2); // plus the ECDSA key hex
    for (const s of secrets) expect(readFileSync("lib/mock-tee.ts", "utf8")).toContain(s);
  });

  it("finds a planted key in a nested chunk and passes a clean bundle", () => {
    const dir = mkdtempSync(join(tmpdir(), "pai-bundle-"));
    mkdirSync(join(dir, "chunks"));
    writeFileSync(join(dir, "chunks", "a.js"), "console.log(1)");
    expect(findLeaks(dir, mockSecrets())).toEqual([]);
    const [s] = mockSecrets();
    writeFileSync(join(dir, "chunks", "b.js"), `const k="${s}";`);
    expect(findLeaks(dir, mockSecrets())).toEqual([{ file: join(dir, "chunks", "b.js"), secret: s }]);
  });

  it("catches the test root in a minified browser bundle", async () => {
    // esbuild (vitest's own) minifies like a production client chunk; the derived keys keep the label literal.
    const out = await build({
      stdin: { contents: 'import { MOCK_ROOT_CA } from "./lib/mock-tee"; console.log(MOCK_ROOT_CA);', resolveDir: process.cwd(), loader: "ts" },
      bundle: true, minify: true, write: false, platform: "browser", format: "esm", alias: { "@": process.cwd() }, logLevel: "silent",
    });
    const dir = mkdtempSync(join(tmpdir(), "pai-bundle-"));
    writeFileSync(join(dir, "chunk.js"), out.outputFiles[0].text);
    expect(findLeaks(dir, mockSecrets()).map((l: { secret: string }) => l.secret)).toContain("pai-mock-tee/");
  });

  it("ships the check into the Docker build context", () => {
    expect(readFileSync(".dockerignore", "utf8").split("\n")).toContain("!scripts/check-test-root.mjs");
  });

  it("runs after every production build", () => {
    expect(JSON.parse(readFileSync("package.json", "utf8")).scripts.build).toMatch(/next build && node scripts\/check-test-root\.mjs/);
  });
});
