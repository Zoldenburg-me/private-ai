import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SafeMarkdown } from "../components/markdown";

const html = (text: string) => renderToStaticMarkup(createElement(SafeMarkdown, { text }));

describe("safe markdown for assistant messages", () => {
  it("renders GFM: emphasis, lists, code, tables, strikethrough", () => {
    const out = html("**bold** _it_ ~~gone~~\n\n- a\n- b\n\n```js\nlet x = 1 < 2;\n```\n\n| h |\n|---|\n| c |");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<del>gone</del>");
    expect(out).toContain("<li>a</li>");
    expect(out).toContain("let x = 1 &lt; 2;");
    expect(out).toMatch(/<table[^>]*>.*<td[^>]*>c<\/td>/s);
  });
  it("drops raw HTML entirely", () => {
    const out = html('hi <script>alert(1)</script><img src="https://t.example/p.gif" onerror="x()"><iframe src="https://e.example"></iframe>');
    expect(out).not.toMatch(/<script|<img|<iframe|onerror/i);
  });
  it("turns images into links and never emits <img>", () => {
    const out = html("![tracking pixel](https://tracker.example/p.gif?leak=secret)");
    expect(out).not.toContain("<img");
    expect(out).toContain('href="https://tracker.example/p.gif?leak=secret"');
    expect(out).toContain("🖼 tracking pixel");
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });
  it("external links open with noopener noreferrer and no referrer", () => {
    const out = html("[docs](https://example.com/x) and https://auto.example");
    expect(out).toMatch(/<a href="https:\/\/example\.com\/x" target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">docs<\/a>/i);
    expect(out).toContain('href="https://auto.example"'); // GFM autolink gets the same treatment
    expect(out.match(/rel="noopener noreferrer nofollow"/g)).toHaveLength(2);
  });
  it("strips javascript: and data: URLs", () => {
    const out = html("[x](javascript:alert(1)) [y](data:text/html;base64,PHNjcmlwdD4=) ![z](javascript:alert(2))");
    expect(out).not.toMatch(/javascript:|data:text/i);
  });
});
