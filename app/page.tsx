import "./landing.css";
import { ModeStory } from "@/components/landing/ModeStory";
import { SealScene } from "@/components/landing/SealScene";
import { BRAND, Closing, Compare, Faq, Hero, HowItWorks, PoweredBy, Pricing, Proof, SiteFooter, SiteNav, Vault, frontierOn } from "@/components/landing/Sections";

// Always per request: the invite-gate copy (INVITE_CODES) must never be frozen at build time.
export const dynamic = "force-dynamic";

export const metadata = {
  title: `${BRAND} · Ask anything, privately`,
  description: "Open models in hardware enclaves. Our server is in Germany, and your chat history stays encrypted in your browser. No email needed.",
  openGraph: { title: `${BRAND} · Ask AI privately, out of sight`, description: "Open models in hardware enclaves. Our server is in Germany. No email needed.", siteName: BRAND, type: "website" },
};

export default async function Landing() {
  const frontier = await frontierOn(); // admin-panel keys count, like in the chat
  return (
    <div className="landing">
      <SiteNav />
      <main id="top">
        <Hero />
        {/* The rest slides up over the hero as one rounded sheet. */}
        <div className="sheet">
        <PoweredBy />
        <SealScene />
        <ModeStory />
        <Vault />
        <HowItWorks />
        <Proof />
        <Compare frontier={frontier} />
        <Pricing frontier={frontier} />
        <Faq />
        <Closing />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
