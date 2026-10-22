import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/tinfoil", () => ({ tinfoilFetch: vi.fn() }));
vi.mock("../lib/privatemode", () => ({ privatemodeFetch: vi.fn() }));

import { providerFetch } from "../lib/provider-fetch";
import { tinfoilFetch } from "../lib/tinfoil";
import { privatemodeFetch } from "../lib/privatemode";

describe("providerFetch (chat, agent and /models all use it)", () => {
  it("sends Tinfoil and Privatemode through their SDK transports and everything else through plain fetch", () => {
    expect(providerFetch("tinfoil")).toBe(tinfoilFetch);
    expect(providerFetch("privatemode")).toBe(privatemodeFetch);
    expect(providerFetch("near")).toBe(fetch);
  });
});
