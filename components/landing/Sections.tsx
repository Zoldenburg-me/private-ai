import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight, ArrowsLeftRight, Check, Minus, X, Cpu, DownloadSimple, Eye, EyeSlash, Fingerprint, Ghost, LockKey, Tag, UserFocus, Vault,
} from "@phosphor-icons/react/dist/ssr";
import { LEVEL_LABEL, NOT_VERIFIED } from "@/lib/client/proof";
import { inviteCodes } from "@/lib/invite";
import { loadProviders } from "@/lib/providers";
import { TIERS, type TierId } from "@/lib/tiers";
import { HeroComposer } from "./HeroComposer";
import { HeroSky } from "./HeroSky";
import { MotionToggle } from "./MotionToggle";
import { ProofDemo } from "./ProofDemo";

export const BRAND = "Hiddensee";
/** The page's "no signup" claims are only true while the invite gate (INVITE_CODES) is off. */
const gated = () => inviteCodes().length > 0;
/** Frontier models are only offered when a gateway is configured (VENICE_API_KEY or LIQUID_API_KEY; an empty <PREFIX>_MODELS turns it off). */
const frontier = () => loadProviders().some((p) => p.privacy === "anon-gateway");
const start = () => (gated() ? "Start chatting with an invite" : "Start chatting, no signup");

function Mark({ size = 28 }: { size?: number }) {
  return <span className="mark-tile" aria-hidden><Image src="/brand/narwhal.svg" alt="" width={size} height={Math.round(size * 132 / 244)} unoptimized /></span>;
}

/** Label that rolls up on hover (Jiro "Roamer" nav); the top copy is decorative. */
function Roll({ children }: { children: string }) {
  return <span className="roll"><span className="roll-top" aria-hidden>{children}</span><span className="roll-main">{children}</span></span>;
}

const NAV: readonly { href: string; label: string }[] = [
  { href: "#compare", label: "Compare" }, { href: "#how", label: "How it works" }, { href: "#proof", label: "Proof" },
  { href: "#pricing", label: "Pricing" }, { href: "#faq", label: "FAQ" },
];

export function SiteNav() {
  return (
    <header className="l-nav">
      <div className="nav-pill">
        <Link href="/" className="wordmark" aria-label={`${BRAND} home`}><Mark size={22} />{BRAND}</Link>
        <nav aria-label="Main">{NAV.map(({ href, label }) => <a key={href} href={href}><Roll>{label}</Roll></a>)}</nav>
        <Link href="/chat" className="btn-solid"><Roll>Start chatting</Roll></Link>
      </div>
    </header>
  );
}

/** Full-screen night lake (Venice-style): stars and moon glitter on the water, centred mark, headline and a working chat bar. */
export function Hero() {
  return (
    <section className="l-hero l-band theme-dark" aria-labelledby="hero-h">
      <div className="lake" aria-hidden />
      <HeroSky />
      <div className="hero-copy">
        <span className="hero-mark" aria-hidden><Mark size={56} /></span>
        <h1 id="hero-h">Ask anything, <em>privately.</em></h1>
        <p className="lead">Private by design. We never store a copy of your chats.</p>
        <HeroComposer />
        <p className="hero-trust">
          <Link href="/chat" className="link-arrow">{start()} <ArrowRight aria-hidden /></Link>
        </p>
      </div>
      <MotionToggle />
    </section>
  );
}

/** Large statement whose words ink in as they scroll into view (CSS scroll timeline; static where unsupported). */
export function Statement({ text }: { text: string }) {
  return (
    <section className="l-statement">
      <p className="reveal">{text.split(" ").map((w, i) => <span key={i} className="w">{w} </span>)}</p>
    </section>
  );
}

type Mark3 = "yes" | "part" | "no";
type Cell = readonly [Mark3, string];
/** One cell per rival, in RIVALS order; a wrong-length row does not compile. */
type Row = { label: string; cells: readonly [us: Cell, chatgpt: Cell, lumo: Cell, duck: Cell] };
const RIVALS = [BRAND, "ChatGPT", "Lumo", "Duck.ai"] as const;
// Competitor facts from each provider's public privacy pages; re-check before each release.
const compareRows = (): readonly Row[] => [
  { label: "Use it without an account", cells: [gated() ? ["part", "Invite-only beta"] : ["yes", "No signup"], ["part", "Limited"], ["part", "Limited"], ["yes", "No signup"]] },
  { label: "Chat history kept off their servers", cells: [["yes", "Only in your browser"], ["no", "Saved to your account"], ["part", "Saved, encrypted"], ["yes", "On your device"]] },
  { label: "Your chats never train models", cells: [["yes", "Never"], ["part", "Opt-out needed"], ["yes", "Never"], ["yes", "Never"]] },
  { label: "Shows what ran your chat", cells: [["part", "Enclave proof per model, every reply signed"], ["no", "No"], ["no", "No"], ["no", "No"]] },
  { label: "Open models", cells: [["yes", "Yes"], ["no", "No"], ["yes", "Yes"], ["part", "Some"]] },
  { label: "Frontier models (GPT, Claude, Gemini)", cells: [frontier() ? ["yes", "Anonymized"] : ["part", "Coming soon, anonymized"], ["part", "OpenAI only"], ["no", "No"], ["yes", "Anonymized"]] },
];
const MARK_ICON = { yes: Check, part: Minus, no: X };

export function Compare() {
  return (
    <section id="compare" className="l-section" aria-labelledby="cmp-h">
      <SectionHead id="cmp-h" eyebrow="Compare" title={<>How it <em>stacks up</em></>} />
      {/* Focusable so keyboard users can scroll the table on narrow screens. */}
      <div className="cmp-wrap" tabIndex={0} role="region" aria-labelledby="cmp-h">
        <table className="cmp">
          <thead><tr><th scope="col"><span className="sr-only">Feature</span></th>{RIVALS.map((r, i) => <th key={r} scope="col" className={i === 0 ? "us" : undefined}>{r}</th>)}</tr></thead>
          <tbody>
            {compareRows().map(({ label, cells }) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {cells.map(([m, note], i) => {
                  const Icon = MARK_ICON[m];
                  return <td key={RIVALS[i]} className={`${i === 0 ? "us " : ""}m-${m}`}><Icon weight="bold" aria-hidden /><span>{note}</span></td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fine">Based on each provider&rsquo;s public privacy information, October 2026.</p>
    </section>
  );
}

const HOPS = [
  { icon: LockKey, title: "Your browser", body: "Encrypts and keeps your history. The key never leaves it.", note: "AES-256-GCM" },
  { icon: ArrowsLeftRight, title: "Our server", body: "Relays messages to the enclave. Never stores or logs them.", note: "in transit only" },
  { icon: Cpu, title: "The enclave", body: "Runs the model on Intel TDX and NVIDIA confidential GPUs, and signs each reply.", note: "attested" },
];

function SectionHead({ id, eyebrow, title }: { id: string; eyebrow: string; title: ReactNode }) {
  return <div className="s-head"><p className="eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2></div>;
}

export function HowItWorks() {
  return (
    <section id="how" className="l-section" aria-labelledby="how-h">
      <SectionHead id="how-h" eyebrow="How it works" title={<>Where your words <em>go</em></>} />
      <ol className="hops">
        {HOPS.map(({ icon: Icon, title, body, note }, i) => (
          <li key={title} className="card">
            <span className="num" aria-hidden>{String(i + 1).padStart(2, "0")}</span>
            <Icon className="hop-icon" aria-hidden /><h3>{title}</h3><p>{body}</p><span className="l-note">{note}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Proof() {
  const labels = { verified: LEVEL_LABEL.verified, "checks-passed": LEVEL_LABEL["checks-passed"], failed: LEVEL_LABEL.failed, unavailable: LEVEL_LABEL.unavailable };
  return (
    <section id="proof" className="l-section" aria-labelledby="proof-h">
      <div className="l-proof card">
        <div className="proof-copy">
          <p className="eyebrow">Proof</p>
          <h2 id="proof-h">Proof, not <em>promises</em></h2>
          <p>Every chat shows what the app checked about the enclave, and every reply carries a signature line. We say &ldquo;Verified&rdquo; only when the hardware certificate chain is verified.</p>
          <details className="not-yet">
            <summary>What we do not verify yet ({NOT_VERIFIED.length})</summary>
            <ul>{NOT_VERIFIED.map((n) => <li key={n}>{n}</li>)}</ul>
          </details>
        </div>
        <ProofDemo labels={labels} />
      </div>
    </section>
  );
}

const SEES = ["Opaque account id", "Plan", "Timestamps", "Usage counters", "Messages while relayed (not logged)"];
const NEVER = ["Chat content (encrypted in your browser)", "Your email (passkeys instead)", "IP-based tracking", "Card data (held by Stripe)"];

export function ServerSees() {
  return (
    <section className="l-section" aria-labelledby="sees-h">
      <SectionHead id="sees-h" eyebrow="Transparency" title={<>What the server <em>sees</em></>} />
      <div className="ledger">
        <div className="card"><h3><Eye aria-hidden />Sees</h3><ul>{SEES.map((s) => <li key={s}>{s}</li>)}</ul></div>
        <div className="card"><h3><EyeSlash aria-hidden />Never stores</h3><ul>{NEVER.map((s) => <li key={s}>{s}</li>)}</ul></div>
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
      <SectionHead id="feat-h" eyebrow="Features" title={<>Also in <em>the box</em></>} />
      <ul className="features">
        {FEATURES.map(({ icon: Icon, title, body }) => <li key={title} className="card"><Icon aria-hidden /><h3>{title}</h3><p>{body}</p></li>)}
      </ul>
    </section>
  );
}

const PLAN_LINES: Record<TierId, string[]> = {
  free: [`${TIERS.free.dailyMessages} messages a day`, `+ ${TIERS.free.incognitoDailyMessages} incognito messages a day`, `${TIERS.free.maxContextTokens / 1000}k context`, "Basic models"],
  pro: [`${TIERS.pro.dailyMessages.toLocaleString("en")} messages a day`, `${TIERS.pro.maxContextTokens / 1000}k context`, "All models"],
  max: ["High fair-use limit", "1M context", "All models"],
};

export function Pricing() {
  return (
    <section id="pricing" className="l-section" aria-labelledby="price-h">
      <SectionHead id="price-h" eyebrow="Pricing" title={<>Simple <em>plans</em></>} />
      <div className="plans-row">
        {(Object.keys(TIERS) as TierId[]).map((id) => (
          <div key={id} className={`l-plan card ${id === "pro" ? "featured l-band theme-dark" : ""}`}>
            <h3>{TIERS[id].name}</h3>
            <p className="l-price">€{TIERS[id].priceEurMonth}<span>/ month</span></p>
            <ul>{PLAN_LINES[id].map((l) => <li key={l}>{l}</li>)}</ul>
            <Link href="/chat" className={id === "pro" ? "btn-solid" : "btn-outline"}>{id === "free" ? "Start free" : `Choose ${TIERS[id].name}`}</Link>
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
      <SectionHead id="faq-h" eyebrow="FAQ" title={<>Questions, <em>answered</em></>} />
      {FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}
    </section>
  );
}

export function Closing() {
  return (
    <section className="l-closing l-band theme-dark" aria-label="Get started">
      {gated() ? <p><span>No email.</span> <em>Just an invite.</em></p> : <p><span>No account.</span> <em>No email.</em></p>}
      <div className="hero-ctas">
        <Link href="/chat" className="btn-solid lg">{start()} <ArrowRight aria-hidden /></Link>
        <Link href="/privacy/metadata" className="btn-outline lg">What the server stores</Link>
      </div>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className="l-footer">
      <div className="foot-row">
        <span className="wordmark"><Mark size={18} />{BRAND}</span>
        <nav aria-label="Legal">
          <Link href="/impressum">Impressum</Link><Link href="/datenschutz">Datenschutz</Link><Link href="/agb">AGB</Link><Link href="/privacy/metadata">What the server stores</Link>
        </nav>
        <span className="copy">© 2026 Zoldenburg UG · {BRAND}</span>
      </div>
      <p className="giant" aria-hidden>{BRAND}</p>
    </footer>
  );
}
