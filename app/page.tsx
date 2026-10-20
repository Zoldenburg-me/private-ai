import "./landing.css";
import { BRAND, Closing, Compare, Faq, Features, Hero, HowItWorks, Pricing, Proof, ServerSees, SiteFooter, SiteNav, Statement } from "@/components/landing/Sections";

// Always per request: the invite-gate copy (INVITE_CODES) must never be frozen at build time.
export const dynamic = "force-dynamic";

export const metadata = {
  title: `${BRAND} · Ask anything, privately`,
  description: "Open models in hardware enclaves. Your chat history stays encrypted in your browser. No email needed.",
};

export default function Landing() {
  return (
    <div className="landing theme-island">
      <SiteNav />
      <main>
        <Hero />
        <Statement text={`Most AI apps ask you to trust them. ${BRAND} shows you what it checked, what it could not check yet, and every field the server keeps.`} />
        <Compare />
        <HowItWorks />
        <Proof />
        <ServerSees />
        <Features />
        <Pricing />
        <Faq />
        <Closing />
      </main>
      <SiteFooter />
    </div>
  );
}
