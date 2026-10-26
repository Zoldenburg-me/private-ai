import Link from "next/link";
import type { ReactNode } from "react";

/** Company details, from the Zoldenburg imprint (zoldhq.com/imprint); Hiddensee keeps its own contact email. */
export const COMPANY = {
  name: "Zoldenburg UG (haftungsbeschränkt)",
  street: "Franz-Josef-Straße 11",
  city: "80801 München",
  director: "Tony Thomas",
  email: "kontakt@zoldenburg.com",
  fax: "+49 89 41629945",
  faxHref: "fax:+498941629945",
  court: "Amtsgericht München",
  hrb: "HRB 317115",
};

const link = { color: "#93c5fd" };
/** English shows by default; #de (the German link or a /page#de URL) swaps to German. Pure CSS, so it works without JS. */
const css = `
.legal section[lang="de"]{display:none}
.legal:has(#de:target) section[lang="de"]{display:block}
.legal:has(#de:target) section[lang="en"]{display:none}
.legal .lang-switch a[href="#en"],.legal:has(#de:target) .lang-switch a[href="#de"]{font-weight:700;text-decoration:none}
.legal:has(#de:target) .lang-switch a[href="#en"]{font-weight:400;text-decoration:underline}
.legal section{scroll-margin-top:200px}
`;

/** Shared shell for legal pages. Both languages are full texts; one is shown at a time. */
export function LegalPage({ children }: { children: ReactNode }) {
  return (
    <main className="legal" style={{ maxWidth: 820, margin: "0 auto", padding: "24px 16px", lineHeight: 1.55 }}>
      <style>{css}</style>
      <p><Link href="/chat" style={link}>← Back to chat</Link> · <Link href="/" style={link}>Home</Link></p>
      <p className="lang-switch" style={{ fontSize: 13, opacity: 0.85 }}>
        <a href="#en" hrefLang="en" lang="en" style={link}>English</a> · <a href="#de" hrefLang="de" lang="de" style={link}>Deutsch</a>
        <span> · In case of doubt the German version prevails. / Im Zweifel gilt die deutsche Fassung.</span>
      </p>
      {children}
      <nav aria-label="Legal" style={{ borderTop: "1px solid #333", marginTop: 32, paddingTop: 12, fontSize: 13 }}>
        <Link href="/impressum" style={link}>Legal notice / Impressum</Link> · <Link href="/datenschutz" style={link}>Privacy / Datenschutz</Link> ·{" "}
        <Link href="/agb" style={link}>Terms / AGB</Link> · <Link href="/privacy/metadata" style={link}>Stored data / Gespeicherte Daten</Link>
      </nav>
    </main>
  );
}

export const Lang = ({ id, children }: { id: "de" | "en"; children: ReactNode }) => (
  <section id={id} lang={id}>{children}</section>
);

/** Shown in dev and tests only; the live site never renders it. For blocks that make no sense until filled in. */
export const Draft = ({ children }: { children: ReactNode }) => (process.env.NODE_ENV === "production" ? null : <>{children}</>);

/** Placeholder for the lawyer review: visible in dev and tests, hidden on the live site. Every TODO must be resolved before launch. */
export const Todo = ({ children }: { children: ReactNode }) => (
  <Draft><mark data-todo="" style={{ background: "#5a4a10", color: "#fde68a", padding: "0 4px", borderRadius: 3 }}>TODO: {children}</mark></Draft>
);
