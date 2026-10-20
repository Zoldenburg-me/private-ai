import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware, buildCsp, config } from "../middleware";

const directives = (csp: string) => Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

describe("Content-Security-Policy", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("/admin is noindex and gets the same strict CSP; other pages are not marked", () => {
    const r = middleware(new NextRequest("https://chat.example.com/admin"));
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(r.headers.get("content-security-policy")).toMatch(/script-src 'self' 'nonce-/);
    expect(middleware(new NextRequest("https://chat.example.com/chat")).headers.get("x-robots-tag")).toBeNull();
  });

  it("production policy: nonce scripts only, no remote images or connections, no framing", () => {
    const d = directives(buildCsp("abc123", false));
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["script-src"]).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
    expect(d["img-src"]).toEqual(["'self'", "data:", "blob:"]);
    expect(d["connect-src"]).toEqual(["'self'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'none'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
    expect(buildCsp("abc123", false)).not.toMatch(/unsafe-eval/);
  });
  it("dev policy additionally allows eval for React refresh", () => {
    expect(directives(buildCsp("n", true))["script-src"]).toContain("'unsafe-eval'");
  });
  it("middleware sets a fresh nonce per request and forwards it to rendering", () => {
    vi.stubEnv("NODE_ENV", "production");
    const a = middleware(new NextRequest("https://chat.example.com/"));
    const b = middleware(new NextRequest("https://chat.example.com/"));
    const csp = a.headers.get("content-security-policy")!;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    expect(nonce).toMatch(/^[A-Za-z0-9+/=]{16,}$/);
    expect(b.headers.get("content-security-policy")).not.toContain(nonce);
    expect(a.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(a.headers.get("strict-transport-security")).toBe("max-age=63072000; includeSubDomains");
  });
  it("no HSTS outside production; API routes and static assets are not matched", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(middleware(new NextRequest("http://localhost:3000/")).headers.get("strict-transport-security")).toBeNull();
    const matcher = JSON.stringify(config.matcher);
    for (const p of ["api", "_next/static", "_next/image", "favicon.ico"]) expect(matcher).toContain(p);
  });
});
