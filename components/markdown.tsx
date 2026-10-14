import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Safe Markdown for assistant output (model text is untrusted):
 * - no raw HTML (skipHtml), no rehype-raw;
 * - dangerous URL schemes (javascript:, data:, ...) are stripped by defaultUrlTransform;
 * - images are never loaded: they become plain links, so a reply cannot make the browser
 *   fetch a remote URL (tracking pixels, data exfiltration via query strings);
 * - links open in a new tab with rel="noopener noreferrer" and no referrer.
 */
const linkProps = { target: "_blank", rel: "noopener noreferrer nofollow", referrerPolicy: "no-referrer" as const };

const components: Components = {
  a: ({ href, children }) => (href ? <a href={href} {...linkProps}>{children}</a> : <span>{children}</span>),
  img: ({ src, alt }) => {
    const label = `🖼 ${alt || "image"}`;
    return typeof src === "string" && src ? <a href={src} {...linkProps} data-md-image="">{label}</a> : <span>{label}</span>;
  },
  table: ({ children }) => <div style={{ overflowX: "auto" }}><table style={{ borderCollapse: "collapse" }}>{children}</table></div>,
  th: ({ children }) => <th style={{ border: "1px solid #333", padding: "2px 6px" }}>{children}</th>,
  td: ({ children }) => <td style={{ border: "1px solid #333", padding: "2px 6px" }}>{children}</td>,
  pre: ({ children }) => <pre style={{ background: "#1a1d24", padding: 8, borderRadius: 4, overflowX: "auto", whiteSpace: "pre" }}>{children}</pre>,
};

export function SafeMarkdown({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={defaultUrlTransform} components={components}>
      {text}
    </Markdown>
  );
}
