import { describe, it, expect } from "vitest";
import { ago, quota } from "../components/app/DashboardView";

describe("dashboard figures", () => {
  it("shows used / limit from the server's remaining count", () => {
    expect(quota({ remaining: 786, limit: 1000 })).toEqual({ v: "214 / 1,000", pct: 21.4 });
    expect(quota({ remaining: 5 }, 20)).toEqual({ v: "15 / 20", pct: 75 });
    expect(quota(null, 20)).toEqual({ v: "…", pct: 0 });
  });
  it("says how long ago an enclave was checked", () => {
    const now = 10 * 3_600_000;
    expect(ago(now - 10_000, now)).toBe("checked just now");
    expect(ago(now - 2 * 60_000, now)).toBe("checked 2 min ago");
    expect(ago(now - 3_600_000, now)).toBe("checked 1 h ago");
  });
});
