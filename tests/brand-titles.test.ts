import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { metadata as chat } from "../app/chat/layout";
import { metadata as admin } from "../app/admin/layout";

// /chat is what invite links point to, so its title is what WhatsApp and Facebook previews show.
describe("page titles carry the Hiddensee name, not the old working title", () => {
  it("chat and admin layouts", () => {
    expect(chat.title).toBe("Chat · Hiddensee");
    expect(admin.title).toBe("Admin · Hiddensee");
  });

  it("root layout (read as text: it loads next/font)", () => {
    const src = readFileSync("app/layout.tsx", "utf8");
    expect(src).not.toMatch(/working title|Private AI chat/);
    expect(src).toContain('siteName: "Hiddensee"');
  });
});
