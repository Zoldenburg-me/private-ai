import "./landing.css";
import { BRAND, Closing, Compare, Faq, Hero, HowItWorks, PoweredBy, Pricing, Proof, ServerSees, SiteFooter, SiteNav, Statement, Video, frontierOn } from "@/components/landing/Sections";

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
    <div className="landing theme-island">
      <SiteNav />
      <main>
        <Hero />
        <Statement />
        <PoweredBy />
        <Compare frontier={frontier} />
        <HowItWorks />
        <Video />
        <Proof />
        <ServerSees />
        <Pricing />
        <Faq />
        <Closing />
      </main>
      <SiteFooter />
    </div>
  );
}
