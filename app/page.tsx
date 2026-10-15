import "./landing.css";
import { Closing, Faq, Features, Hero, HowItWorks, Pricing, Proof, ServerSees, SiteFooter, SiteNav, Statement } from "@/components/landing/Sections";

export const metadata = {
  title: "Private AI · Ask anything, privately",
  description: "Open models in hardware enclaves. Your chat history stays encrypted in your browser. No signup, no email.",
};

export default function Landing() {
  return (
    <div className="landing theme-dark">
      <SiteNav />
      <main>
        <Hero />
        <Statement quiet="Most AI apps ask you to trust them." point="This one shows you what it checked." />
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
