import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight, ArrowUp, ArrowsLeftRight, Cpu, DownloadSimple, Eye, EyeSlash, Fingerprint, Ghost, LockKey, Shield, Tag, UserFocus, Vault,
} from "@phosphor-icons/react/dist/ssr";
import { LEVEL_LABEL, NOT_VERIFIED } from "@/lib/client/proof";
import { TIERS, type TierId } from "@/lib/tiers";
import { HeroSilk } from "./HeroSilk";
import { ProofDemo } from "./ProofDemo";

const START = "Start chatting, no signup";

function Mark({ size = 28 }: { size?: number }) {
  return <Image src="/brand/narwhal.svg" alt="" width={size} height={Math.round(size * 132 / 244)} unoptimized />;
}

export function SiteNav() {
  return (
    <header className="l-nav">
      <Link href="/" className="wordmark" aria-label="Private AI home"><Mark />Private AI<span className="sq" aria-hidden /></Link>
      <nav aria-label="Main">
        <a href="#how">How it works</a><a href="#proof">Proof</a><a href="#pricing">Pricing</a><a href="#faq">FAQ</a>
      </nav>
      <Link href="/chat" className="btn-accent">Start chatting</Link>
    </header>
  );
}

export function Hero() {
  return (
    <section className="l-hero" aria-labelledby="hero-h">
      <HeroSilk />
      <div className="hero-copy">
        <span className="hero-mark" aria-hidden><Mark size={44} /></span>
        <h1 id="hero-h">How can I help,<em>privately?</em></h1>
        <p className="lead">Open models run inside hardware enclaves. Your history stays encrypted in your browser.</p>
        <Link href="/chat" className="composer-preview" aria-label={START}>
          <span className="cp-input">Ask anything privately…</span>
          <span className="cp-row">
            <span className="demo-model">Open model <span className="tag-ok">TEE</span></span>
            <span className="badge tone-warn"><Shield weight="duotone" aria-hidden />Enclave checks passed<span className="chain">chain unverified</span></span>
            <span className="cp-send" aria-hidden><ArrowUp weight="bold" /></span>
          </span>
        </Link>
        <div className="hero-ctas">
          <Link href="/chat" className="btn-accent lg">{START}</Link>
          <a href="#proof" className="link-arrow">How the proof works <ArrowRight aria-hidden /></a>
        </div>
      </div>
    </section>
  );
}

export function Statement({ quiet, point }: { quiet: string; point: string }) {
  return <section className="l-statement"><p><span>{quiet}</span> <em>{point}</em></p></section>;
}

const HOPS = [
  { icon: LockKey, title: "Your browser", body: "Encrypts and keeps your history. The key never leaves it.", note: "AES-256-GCM" },
  { icon: ArrowsLeftRight, title: "Our server", body: "Relays messages to the enclave. Never stores or logs them.", note: "in transit only" },
  { icon: Cpu, title: "The enclave", body: "Runs the model on Intel TDX and NVIDIA confidential GPUs, and signs each reply.", note: "attested" },
];

export function HowItWorks() {
  return (
    <section id="how" className="l-section" aria-labelledby="how-h">
      <span className="pill">How it works</span>
      <h2 id="how-h">Where your words go</h2>
      <ol className="hops">
        {HOPS.map(({ icon: Icon, title, body, note }) => (
          <li key={title}><Icon className="hop-icon" aria-hidden /><h3>{title}</h3><p>{body}</p><span className="l-note">{note}</span></li>
        ))}
      </ol>
    </section>
  );
}

export function Proof() {
  const labels = { verified: LEVEL_LABEL.verified, "checks-passed": LEVEL_LABEL["checks-passed"], failed: LEVEL_LABEL.failed, unavailable: LEVEL_LABEL.unavailable };
  return (
    <section id="proof" className="l-section l-proof" aria-labelledby="proof-h">
      <div className="proof-copy">
        <h2 id="proof-h">Proof, not promises</h2>
        <p>Every chat shows what the app checked about the enclave, and every reply carries a signature line. We say &ldquo;Verified&rdquo; only when the hardware certificate chain is verified.</p>
        <details className="not-yet">
          <summary>What we do not verify yet ({NOT_VERIFIED.length})</summary>
          <ul>{NOT_VERIFIED.map((n) => <li key={n}>{n}</li>)}</ul>
        </details>
      </div>
      <ProofDemo labels={labels} />
    </section>
  );
}

const SEES = ["Opaque account id", "Plan", "Timestamps", "Usage counters", "Messages while relayed (not logged)"];
const NEVER = ["Chat content (encrypted in your browser)", "Your email (passkeys instead)", "IP-based tracking", "Card data (held by Stripe)"];

export function ServerSees() {
  return (
    <section className="l-section" aria-labelledby="sees-h">
      <h2 id="sees-h">What the server sees</h2>
      <div className="ledger">
        <div><h3><Eye aria-hidden />Sees</h3><ul>{SEES.map((s) => <li key={s}>{s}</li>)}</ul></div>
        <div><h3><EyeSlash aria-hidden />Never stores</h3><ul>{NEVER.map((s) => <li key={s}>{s}</li>)}</ul></div>
      </div>
      <Link href="/privacy/metadata" className="link-arrow">Every stored field, listed <ArrowRight aria-hidden /></Link>
    </section>
  );
}

const FEATURES = [
  { icon: Ghost, title: "Ghost chat", body: "Never saved, not even encrypted." },
  { icon: UserFocus, title: "Personas", body: "Private system prompts that stay in this browser." },
  { icon: Vault, title: "Encrypted backup", body: "Export and restore with a passphrase." },
  { icon: Fingerprint, title: "Passkeys", body: "No email. The same plan on every device." },
  { icon: Tag, title: "Privacy tags", body: "Every model labelled TEE, private or anonymized." },
  { icon: DownloadSimple, title: "Your data, on request", body: "Download or delete your account data in one click." },
];

export function Features() {
  return (
    <section className="l-section" aria-labelledby="feat-h">
      <h2 id="feat-h">Also in the box</h2>
      <ul className="features">
        {FEATURES.map(({ icon: Icon, title, body }) => <li key={title}><Icon aria-hidden /><h3>{title}</h3><p>{body}</p></li>)}
      </ul>
    </section>
  );
}

const PLAN_LINES: Record<TierId, string[]> = {
  free: [`${TIERS.free.dailyMessages} messages a day`, `${TIERS.free.maxContextTokens / 1000}k context`, "Basic models"],
  pro: [`${TIERS.pro.dailyMessages.toLocaleString("en")} messages a day`, `${TIERS.pro.maxContextTokens / 1000}k context`, "All models"],
  max: ["High fair-use limit", "1M context", "All models"],
};

export function Pricing() {
  return (
    <section id="pricing" className="l-section" aria-labelledby="price-h">
      <span className="pill">Pricing</span>
      <h2 id="price-h">Plans</h2>
      <div className="plans-row">
        {(Object.keys(TIERS) as TierId[]).map((id) => (
          <div key={id} className={`l-plan ${id === "pro" ? "featured" : ""}`}>
            <h3>{TIERS[id].name}</h3>
            <p className="l-price">€{TIERS[id].priceEurMonth}<span>/ month</span></p>
            <ul>{PLAN_LINES[id].map((l) => <li key={l}>{l}</li>)}</ul>
            <Link href="/chat" className={id === "pro" ? "btn-accent" : "btn-quiet"}>{id === "free" ? "Start free" : `Choose ${TIERS[id].name}`}</Link>
          </div>
        ))}
      </div>
      <p className="fine">Proposed prices, not final. You upgrade inside the app; card data goes to Stripe.</p>
    </section>
  );
}

const FAQ = [
  ["Can you read my chats?", "Not stored ones: your history is encrypted in your browser. Messages do pass through our server on the way to the enclave. We relay them and never store or log their content."],
  ["What is an enclave?", "A sealed area of a processor, here Intel TDX with NVIDIA confidential GPUs, whose memory the host machine cannot read. It produces a signed report of what is running, and this app checks that report."],
  ["What if I lose my browser data?", "Your history is gone unless you exported an encrypted backup. Your plan is safe if you saved a passkey: log in with it on any device."],
  ["Why no email?", "We do not need it. Your account is an opaque id, and a passkey links it across devices."],
  ["Is this GDPR compliant?", "We keep only what plans and limits need, and you can download or delete it in one click. The details are in the Datenschutzerklärung."],
];

export function Faq() {
  return (
    <section id="faq" className="l-section l-faq" aria-labelledby="faq-h">
      <h2 id="faq-h">Questions</h2>
      {FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}
    </section>
  );
}

export function Closing() {
  return (
    <section className="l-closing">
      <p><span>No account.</span> <em>No email.</em></p>
      <Link href="/chat" className="btn-accent lg">{START}</Link>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className="l-footer">
      <span className="wordmark"><Mark size={22} />Private AI<span className="sq" aria-hidden /></span>
      <nav aria-label="Legal">
        <Link href="/impressum">Impressum</Link><Link href="/datenschutz">Datenschutz</Link><Link href="/agb">AGB</Link><Link href="/privacy/metadata">What the server stores</Link>
      </nav>
      <span className="copy">© 2026 Private AI</span>
    </footer>
  );
}
