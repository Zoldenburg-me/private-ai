import { describe, it, expect } from "vitest";
import { chatUrl } from "../components/landing/chat-url";

// The hero prompt travels in the URL fragment, which browsers never send to the server (AGENTS.md: no content on the server).
describe("hero chat bar URL", () => {
  it("puts the prompt in the fragment, never the query string", () => {
    const url = new URL(chatUrl("hello world")!, "https://example.test");
    expect(url.pathname).toBe("/chat");
    expect(url.search).toBe("?ghost=1");
    expect(url.hash).toBe("#q=hello%20world");
  });

  it("encodes characters that would break the fragment and keeps new lines", () => {
    const text = "a&b=c #tag?\nline 2 ü";
    const url = chatUrl(text)!;
    expect(url).toBe(`/chat?ghost=1#q=${encodeURIComponent(text)}`);
    expect(decodeURIComponent(url.split("#q=")[1])).toBe(text);
  });

  it("trims, and gives nothing for a blank prompt", () => {
    expect(chatUrl("  hi \n")).toBe("/chat?ghost=1#q=hi");
    expect(chatUrl("   \n ")).toBeNull();
  });
});
