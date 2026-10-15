import Link from "next/link";
import type { ReactNode } from "react";

/** Shared shell for legal pages. Both languages on one page: German (binding) first, then English. */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "24px 16px", lineHeight: 1.55 }}>
      <p><Link href="/chat" style={{ color: "#93c5fd" }}>← Back to chat</Link> · <Link href="/" style={{ color: "#93c5fd" }}>Private AI home</Link></p>
      <h1>{title}</h1>
      <p style={{ fontSize: 13, opacity: 0.8 }}>
        <a href="#de" style={{ color: "#93c5fd" }}>Deutsch</a> · <a href="#en" style={{ color: "#93c5fd" }}>English</a> ·
        Im Zweifel gilt die deutsche Fassung. / In case of doubt the German version prevails.
      </p>
      {children}
    </main>
  );
}

export const Lang = ({ id, children }: { id: "de" | "en"; children: ReactNode }) => (
  <section id={id} lang={id} style={{ borderTop: "1px solid #333", marginTop: 24 }}>{children}</section>
);

/** Visible placeholder; every TODO must be resolved by a lawyer before launch. */
export const Todo = ({ children }: { children: ReactNode }) => (
  <mark data-todo="" style={{ background: "#5a4a10", color: "#fde68a", padding: "0 4px", borderRadius: 3 }}>TODO: {children}</mark>
);
