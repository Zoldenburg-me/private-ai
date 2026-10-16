import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The `map {remote_host} {client_key}` rules from deploy/caddy/Caddyfile, applied the way Caddy does:
// first matching regex wins, output = Go ReplaceAllString(input, output) with ${N} capture refs.
const caddyfile = readFileSync(join(__dirname, "../deploy/caddy/Caddyfile"), "utf8");
const block = /map \{remote_host\} \{client_key\} \{([\s\S]*?)\n\t\}/.exec(caddyfile)![1];
const rules = [...block.matchAll(/^\s*~(\S+) "(.*)"$/gm)].map(([, re, out]) => ({ re: new RegExp(re), out: out.replace(/\$\{(\d+)\}/g, "$$$1") }));
const clientKey = (ip: string) => { const r = rules.find((x) => x.re.test(ip))!; return ip.replace(r.re, r.out); };

// RFC 5952 text form, the same as Go's net.IP.String() that Caddy's {remote_host} uses.
const compressed = (groups: number[]) => new URL(`http://[${groups.map((g) => g.toString(16)).join(":")}]`).hostname.slice(1, -1);

describe("Caddy rate-limit key", () => {
  it("has the rules", () => { expect(rules.length).toBeGreaterThan(10); });

  it("keys IPv6 on its /64 for every placement of zero groups", () => {
    for (let mask = 0; mask < 256; mask++) {
      const groups = Array.from({ length: 8 }, (_, i) => (mask >> i) & 1 ? 0 : 0x1a2b + i);
      expect(clientKey(compressed(groups)), compressed(groups)).toBe(groups.slice(0, 4).map((g) => g.toString(16)).join(":"));
    }
  });

  it("gives every address in one /64 the same key, and other /64s another", () => {
    const a = clientKey("2001:db8:0:0:1:2:3:4");
    expect(clientKey(compressed([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]))).toBe(a);
    expect(clientKey(compressed([0x2001, 0xdb8, 0, 0, 1, 0, 0, 0]))).toBe(a);
    expect(clientKey(compressed([0x2001, 0xdb8, 0, 1, 1, 0, 0, 0]))).not.toBe(a);
  });

  it("keeps IPv4 as is", () => { expect(clientKey("203.0.113.7")).toBe("203.0.113.7"); });
});
