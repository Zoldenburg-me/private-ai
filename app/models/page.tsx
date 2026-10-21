import "../landing.css";
import "./models.css";
import Image from "next/image";
import Link from "next/link";
import { BRAND, SiteFooter } from "@/components/landing/Sections";
import { getCatalog } from "@/lib/catalog-cache";
import { ModelsBrowser } from "./ModelsBrowser";
import { toRows, type ModelRow } from "./rows";

// The catalog depends on which provider keys are configured right now; never freeze it at build time.
export const dynamic = "force-dynamic";

export const metadata = {
  title: `Models · ${BRAND}`,
  description: "Every model you can pick in the chat, how private it is, and which plan includes it.",
};

export default async function ModelsPage() {
  // A store or provider outage shows an empty list with a note, never made-up models.
  let rows: ModelRow[] | null = null;
  try { rows = toRows(await getCatalog()); } catch { rows = null; }
  return (
    <div className="landing theme-island">
      <header className="mdl-nav">
        <Link href="/" className="mdl-brand"><span className="mark-tile mdl-mark" aria-hidden><Image src="/brand/narwhal.svg" alt="" width={22} height={12} unoptimized /></span>{BRAND}</Link>
        <nav aria-label="Main">
          <Link href="/chat">Chat</Link>
          <span aria-current="page">Models</span>
        </nav>
        <span className="mdl-spacer" />
        <Link href="/chat" className="mdl-cta">Start chatting</Link>
      </header>
      <main>
        <div className="mdl-hero">
          <h1>Every model, <em>and where it runs.</em></h1>
          <p>Filter by how private a model is, who serves it, or what your plan unlocks. Enclave models come with an attestation report you can check in the chat.</p>
        </div>
        {rows ? <ModelsBrowser rows={rows} /> : <p className="mdl-empty mdl-pad">The model list could not be loaded right now. Please try again in a minute.</p>}
      </main>
      <SiteFooter />
    </div>
  );
}
