import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight, ArrowsLeftRight, Check, Cpu, Eye, EyeSlash, Key, LockSimple, Minus, Monitor, Plus, ShieldCheck, X,
} from "@phosphor-icons/react/dist/ssr";
import { NOT_VERIFIED } from "@/lib/client/proof";
import { inviteCodes } from "@/lib/invite";
import { DEFS, loadProviders } from "@/lib/providers";
import { liveProviders } from "@/lib/provider-keys";
import { FRONTIER_MODELS, TIERS, type Tier, type TierId } from "@/lib/tiers";
import { DotField } from "./DotField";
import { DotNarwhal } from "./DotNarwhal";
import { HeroComposer } from "./HeroComposer";
import { RepelArt } from "./RepelArt";
import { SoundToggle } from "./SoundToggle";
import { VaultSeal } from "./VaultSeal";

export const BRAND = "Hiddensee";
/** The page's "no signup" claims are only true while the invite gate (INVITE_CODES) is off. */
export const gated = () => inviteCodes().length > 0;
/** Frontier models are only offered when a gateway is configured (VENICE_API_KEY or LIQUID_API_KEY; an empty <PREFIX>_MODELS turns it off). */
const frontier = () => loadProviders().some((p) => p.privacy === "anon-gateway");
/** The same check with admin-panel keys (what the chat uses). If the key store is down, fall back to env keys: claim less, never more. */
export async function frontierOn(load: () => Promise<{ privacy: string }[]> = liveProviders): Promise<boolean> {
  try { return (await load()).some((p) => p.privacy === "anon-gateway"); } catch { return frontier(); }
}
const start = () => (gated() ? "Start chatting with an invite" : "Start chatting, no signup");

/** The narwhal on its ink tile, like an app icon (same tile in both themes). */
export function Mark({ size = 22 }: { size?: number }) {
  return <span className="mark-tile" aria-hidden><Image src="/brand/narwhal.svg" alt="" width={size} height={Math.round(size * 132 / 244)} unoptimized /></span>;
}

const NAV: readonly { href: string; label: string }[] = [
  { href: "/#how", label: "How it works" }, { href: "/#proof", label: "Proof" }, { href: "/#compare", label: "Compare" },
  { href: "/models", label: "Models" }, { href: "/#pricing", label: "Pricing" }, { href: "/#faq", label: "FAQ" }, { href: "/about", label: "About" },
];

export function SiteNav({ current }: { current?: string } = {}) {
  return (
    <header className="l-nav">
      <div className="l-wrap nav-row">
        <Link href="/" className="wordmark" aria-label={`${BRAND} home`}><Mark />{BRAND}</Link>
        <nav aria-label="Main">{NAV.map(({ href, label }) => <a key={href} href={href} className="navlink" aria-current={href === current ? "page" : undefined}>{label}</a>)}</nav>
        <div className="nav-end">
          <SoundToggle />
          {/* Passkey login lives in the chat's settings. */}
          <Link href="/chat" className="navlink nav-login">Log in</Link>
          <Link href="/chat" className="pill pill-ink">Start chatting</Link>
        </div>
      </div>
    </header>
  );
}

/** Centered hero: the dot narwhal resolving above the headline, a working chat bar, and decorative proof tiles on wide screens. */
export function Hero() {
  return (
    <section className="l-wrap l-hero" aria-labelledby="hero-h">
      <HeroTiles />
      <DotNarwhal />
      <div className="hero-copy rise">
        <h1 id="hero-h">Ask anything.<br /><span>No one else sees it.</span></h1>
        <p className="lead">Open models run in sealed hardware enclaves. Your history stays encrypted in your browser. No email needed.</p>
        <HeroComposer />
        <p><Link href="/chat" className="link-arrow">{start()} <ArrowRight aria-hidden /></Link></p>
      </div>
    </section>
  );
}

/** Floating examples of what the app shows (decorative, hidden below 1360px). */
function HeroTiles() {
  return (
    <div aria-hidden>
      <div className="tile px1 tile-a">
        <div className="tile-ok"><span />Checked before you chat</div>
        <div className="tile-mono">TDX quote · GPU report<br />key bound to the model</div>
      </div>
      <div className="tile px2 tile-b">
        <Image src="/brand/narwhal-tee.svg" alt="" width={56} height={56} unoptimized />
        <div><div className="tile-h">Max Privacy</div><div className="tile-sub">Sealed in hardware</div></div>
      </div>
      <div className="tile px2 tile-c">
        <div className="tile-h"><LockSimple aria-hidden />Saved on this device</div>
        <div className="tile-mono accent">x9Fq·Lm2v·Q7aK·pT0z·Wc4N·8hRe·sY1u·Jb6D</div>
        <div className="tile-sub">Encrypted before it is stored</div>
      </div>
      <div className="tile px1 tile-d">
        <div className="tile-pair">
          <Image src="/brand/narwhal-pixel/narwhal-ink-default.svg" alt="" width={48} height={48} unoptimized />
          <Image src="/brand/narwhal-pixel/narwhal-classic-default.svg" alt="" width={48} height={48} unoptimized />
        </div>
        <div className="tile-sub">Private and Anon modes</div>
      </div>
    </div>
  );
}

/** Partner logos (from each brand's kit, in public/brand/partners); providers without one show their name. */
const LOGO: Record<string, { src: string; w: number; h: number }> = {
  near: { src: "/brand/partners/near-ai.svg", w: 449, h: 85 },
  phala: { src: "/brand/partners/phala.svg", w: 138, h: 48 },
  venice: { src: "/brand/partners/venice.svg", w: 467, h: 212 },
};

function Partner({ id, name }: { id: string; name: string }) {
  const logo = LOGO[id];
  return <li>{logo ? <Image src={logo.src} alt={name} width={logo.w} height={logo.h} unoptimized className={`logo partner-${id}`} /> : <span className="logo logo-word">{name}</span>}</li>;
}

/** The partners we run on. Shown always: their keys live in the admin panel (the database), which the
 *  landing page does not read. Gateways (Venice, Liquid) are not confidential compute, so they get their own group. */
const TEE_PARTNERS = ["near", "phala", "tinfoil"];
const GATEWAY_PARTNERS = ["venice", "liquid"];
const partnerName = (id: string) => (DEFS.find((d) => d.id === id)?.name ?? id).replace(/ \(.*\)$/, "");

export function PoweredBy() {
  return (
    <section className="l-partners" aria-label="Partners">
      <div className="l-wrap partners-row">
        <div className="partner-group">
          <p>Runs on confidential compute from</p>
          <ul>{TEE_PARTNERS.map((id) => <Partner key={id} id={id} name={partnerName(id)} />)}</ul>
        </div>
        <div className="partner-group">
          <p>Frontier models via</p>
          <ul>{GATEWAY_PARTNERS.map((id) => <Partner key={id} id={id} name={partnerName(id)} />)}</ul>
        </div>
      </div>
    </section>
  );
}

/** Full-width band: a saved chat in plain words, and the same chat as the browser stores it. */
export function Vault() {
  return (
    <section className="l-vault" aria-labelledby="vault-h">
      <div className="vault-light">
        <h2 id="vault-h">Saved chats are sealed on your device.</h2>
        <div className="vault-chat">
          <p className="l-bubble">My ferritin came back at 9. Should I be worried?</p>
          <p className="reply">That is below the usual range, which often points to low iron stores. It is worth asking your doctor about...</p>
        </div>
      </div>
      <VaultSeal />
    </section>
  );
}

const STOPS = [
  { icon: Monitor, title: "Your browser", body: "Encrypts and keeps your history. The key never leaves this device.", note: "AES-256-GCM" },
  { icon: ArrowsLeftRight, title: "Our relay in Germany", body: "Passes messages to the enclave. Never stores or logs them.", note: "In transit only" },
  { icon: Cpu, title: "The enclave", body: "Runs the model on Intel TDX and NVIDIA confidential GPUs, and signs replies where the provider supports it. The host machine cannot look inside.", note: "Attested before you chat" },
];

export function HowItWorks() {
  return (
    <section id="how" className="l-how" aria-labelledby="how-h">
      <div className="l-wrap">
        <h2 id="how-h" className="display">Three stops. Only your browser keeps a copy.</h2>
        <ol className="stops" data-repel-area>
          <li className="rail" aria-hidden><DotField gapX={14} gapY={10} r={3} bleed={24} /></li>
          {STOPS.map(({ icon: Icon, title, body, note }, i) => {
            const last = i === STOPS.length - 1;
            return (
              <li key={title} className={last ? "stop stop-enclave" : "stop"}>
                {last && <span className="rail-flow" aria-hidden><DotField gapX={14} gapY={10} r={3} bleed={24} className="accent" /></span>}
                <span className="stop-dot" aria-hidden />
                <Icon className="stop-icon" weight="light" aria-hidden />
                <h3>{title}</h3>
                <p>{body}</p>
                <code>{note}</code>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

const SEES = ["Opaque account id", "Your plan and usage counters", "Timestamps", "Messages while relayed, never logged"];
const NEVER = ["Chat content, encrypted in your browser", "Your email, there is none", "IP-based tracking", "Card data, held by Stripe"];

/** Bento: the proof card (an example, the landing page checks nothing), passkeys, the explainer video and the server ledger. */
export function Proof() {
  return (
    <section id="proof" className="l-wrap l-section" aria-labelledby="proof-h">
      <div className="bento">
        <div className="l-card proof-card">
          <div className="proof-copy">
            <h2 id="proof-h">Proof, not promises.</h2>
            <p>Before you chat, the app checks that the model runs in a sealed enclave and shows you exactly what passed.</p>
          </div>
          <figure className="demo">
            <div className="demo-top">
              <span className="demo-model">GLM 5.3</span>
              <span className="demo-route">NEAR AI enclave</span>
              <span className="demo-status"><ShieldCheck weight="bold" aria-hidden />Enclave checks passed</span>
            </div>
            <p className="demo-reply">Narwhals are toothed whales that live year-round in the Arctic. The long tusk is an elongated canine tooth, packed with nerve endings.</p>
            <figcaption><span>TDX quote checked</span><span>signature matches the enclave&rsquo;s key</span><span>chain not verified yet</span></figcaption>
          </figure>
          <p className="fine">Example reply. In the app these checks run before you chat, and the proof panel shows the result.</p>
          <details className="l-tech">
            <summary>Technical details<Plus className="chev" aria-hidden /></summary>
            <p>Replies carry a signature line where the provider supports it. We say &ldquo;Verified&rdquo; only when the hardware certificate chain is verified. Not verified yet:</p>
            <ul>{NOT_VERIFIED.map((n) => <li key={n}>{n}</li>)}</ul>
          </details>
        </div>
        <div className="bento-side">
          <div className="l-card card-blue">
            <Key size={32} weight="light" aria-hidden />
            <div>
              <h3>No email. Just a passkey.</h3>
              <p>Your account is an opaque id. A passkey links it across your devices.</p>
            </div>
          </div>
          <div id="video" className="l-card card-video">
            <video src="/media/hiddensee-how-it-works.mp4" poster="/media/hiddensee-how-it-works-poster.jpg" controls playsInline preload="none" aria-label="How Hiddensee works, in two minutes" />
            <p>How it works, in two minutes</p>
          </div>
        </div>
        <div className="l-card ledger">
          <DotField />
          <h3>What our server sees, and what it never stores.</h3>
          <div className="ledger-col">
            <p className="ledger-h"><Eye aria-hidden />Sees</p>
            <ul>{SEES.map((s) => <li key={s}>{s}</li>)}</ul>
          </div>
          <div className="ledger-col">
            <p className="ledger-h accent"><EyeSlash aria-hidden />Never stores</p>
            <ul>{NEVER.map((s) => <li key={s}>{s}</li>)}</ul>
          </div>
          <Link href="/privacy/metadata" className="link-arrow">Every stored field, listed <ArrowRight aria-hidden /></Link>
        </div>
      </div>
    </section>
  );
}

type Mark3 = "yes" | "part" | "no";
type Cell = readonly [Mark3, string];
/** One cell per rival, in RIVALS order; a wrong-length row does not compile. */
type Row = { label: string; cells: readonly [us: Cell, chatgpt: Cell, lumo: Cell, duck: Cell] };
const RIVALS = [BRAND, "ChatGPT", "Lumo", "Duck.ai"] as const;
// Competitor facts from each provider's public privacy pages; re-check before each release.
const compareRows = (frontierLive: boolean): readonly Row[] => [
  { label: "Use it without an account", cells: [gated() ? ["part", "Invite-only beta"] : ["yes", "No signup"], ["part", "Limited"], ["part", "Limited"], ["yes", "No signup"]] },
  { label: "Chat history kept off their servers", cells: [["yes", "Only in your browser"], ["no", "Saved to your account"], ["part", "Saved, encrypted"], ["yes", "On your device"]] },
  { label: "Your chats never train models", cells: [["yes", "Never"], ["part", "Opt-out needed"], ["yes", "Never"], ["yes", "Never"]] },
  { label: "Shows what ran your chat", cells: [["part", "Enclave proof per model, replies signed where supported"], ["no", "No"], ["no", "No"], ["no", "No"]] },
  { label: "Open models", cells: [["yes", "Yes"], ["no", "No"], ["yes", "Yes"], ["part", "Some"]] },
  { label: "Frontier models (GPT, Claude, Gemini)", cells: [frontierLive ? ["yes", "Anonymized"] : ["part", "Coming soon, anonymized"], ["part", "OpenAI only"], ["no", "No"], ["yes", "Anonymized"]] },
];
const MARK_ICON = { yes: Check, part: Minus, no: X };
const MARK_TEXT = { yes: "Yes", part: "Partly", no: "No" };

export function Compare({ frontier: frontierLive = frontier() }: { frontier?: boolean } = {}) {
  return (
    <section id="compare" className="l-wrap l-section" aria-labelledby="cmp-h">
      <h2 id="cmp-h" className="h2">How it compares</h2>
      {/* Focusable so keyboard users can scroll the table on narrow screens. */}
      <div className="cmp-wrap" tabIndex={0} role="region" aria-labelledby="cmp-h">
        <table className="cmp">
          <thead><tr><th scope="col">Feature</th>{RIVALS.map((r, i) => <th key={r} scope="col" className={i === 0 ? "us" : undefined}>{r}</th>)}</tr></thead>
          <tbody>
            {compareRows(frontierLive).map(({ label, cells }) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {cells.map(([m, note], i) => {
                  const Icon = MARK_ICON[m];
                  return <td key={RIVALS[i]} className={`${i === 0 ? "us " : ""}m-${m}`}><Icon weight="bold" aria-label={MARK_TEXT[m]} /><span>{note}</span></td>;
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

// Plan copy is derived from lib/tiers.ts only: no number on this page that TIERS lacks.
const n = (v: number) => v.toLocaleString("en");
const ctx = (tokens: number) => (tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1000)}k`);
const times = (a: number, b: number) => (b > 0 && a > b ? `${n(Math.round(a / b))} times Free. ` : "");
/** The top frontier models' logos, from their FRONTIER_MODELS ids. */
const FRONTIER_LOGO: readonly { prefix: string; name: string }[] = [
  { prefix: "claude", name: "Claude" }, { prefix: "gemini", name: "Gemini" }, { prefix: "gpt", name: "ChatGPT" }, { prefix: "grok", name: "Grok" },
];
const frontierLogos = () => FRONTIER_LOGO.filter((l) => [...FRONTIER_MODELS].some((id) => id.startsWith(l.prefix)));

function bigFeatures(t: Tier, frontierLive: boolean) {
  const free = TIERS.free;
  const logos = frontierLogos();
  return [
    { title: `${n(t.dailyMessages)} Max privacy messages a day`, note: `${times(t.dailyMessages, free.dailyMessages)}Sealed in hardware the host machine cannot read.` },
    ...(t.topDailyMessages ? [{ title: `${n(t.topDailyMessages)} top Max privacy messages a day`, note: "The largest models that run in an enclave, such as Kimi K3." }] : []),
    { title: `${n(t.incognitoDailyMessages)} private and incognito messages a day`, note: `${times(t.incognitoDailyMessages, free.incognitoDailyMessages)}For anything that does not need an enclave.` },
    ...(frontierLive && logos.length ? [{ title: "Top frontier models, anonymously", note: `${logos.map((l) => l.name).join(", ")} through an anonymizing gateway. €${t.includedCreditsEur} of credit included every month, then pay as you go.`, logos }] : []),
    { title: `${ctx(t.maxContextTokens)} context`, note: `Paste long contracts or a whole thread, with replies up to ${ctx(t.maxOutputTokens)} tokens.` },
    { title: "Agentic tasks", note: `Hand over a multi-step job and it plans and works through it, up to ${t.agentMaxSteps} steps per run.` },
  ];
}
const summary = (t: Tier, frontierLive: boolean) => [
  `${n(t.dailyMessages)} Max privacy${t.topDailyMessages ? `, ${n(t.topDailyMessages)} top` : ""} and ${n(t.incognitoDailyMessages)} private messages a day`,
  ...(frontierLive && t.includedCreditsEur ? [`€${t.includedCreditsEur} frontier credit a month`] : []), // Free cannot use the top frontier models
  `${ctx(t.maxContextTokens)} context`,
].join(", ") + ".";
const price = (t: Tier) => `€${t.priceEurMonth}`;

/** Pricing: Pro as the big card, every other plan TIERS has stacked beside it. */
export function Pricing({ frontier: frontierLive = frontier() }: { frontier?: boolean } = {}) {
  const ids = Object.keys(TIERS) as TierId[];
  const big = TIERS.pro;
  const small = ids.filter((id) => id !== big.id).map((id) => TIERS[id]);
  return (
    <section id="pricing" className="l-wrap l-section" aria-labelledby="price-h">
      <div className="price-head">
        <h2 id="price-h" className="h2">Start free. Upgrade when it sticks.</h2>
        <p>Paid plans differ only in how much you get.</p>
      </div>
      <div className="l-plans">
        <div className="plan-big">
          <div className="plan-big-main">
            <div className="plan-big-top">
              <div className="plan-name"><h3>{big.name}</h3><span className="badge">Most picked</span></div>
              <p>For people who use AI every day and don&rsquo;t want to think about limits.</p>
            </div>
            <div className="plan-big-buy">
              <p className="plan-price"><span>{price(big)}</span> / month</p>
              <Link href="/chat" className="pill pill-light">Choose {big.name}</Link>
              <p className="plan-fine">You upgrade inside the app. Card data stays with Stripe.</p>
            </div>
          </div>
          <div className="plan-big-list">
            <p>What you get with {big.name}:</p>
            <ul>
              {bigFeatures(big, frontierLive).map((f) => (
                <li key={f.title}>
                  <Check weight="bold" aria-hidden />
                  <span>
                    <span className="f-title">{f.title}</span>
                    <span className="f-note">{f.note}</span>
                    {"logos" in f && f.logos && (
                      <span className="f-logos">{f.logos.map((l) => <Image key={l.name} src={`/brand/frontier/${l.name.toLowerCase()}.svg`} alt={l.name} title={l.name} width={18} height={18} unoptimized />)}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="plans-small">
          {small.map((t) => (
            <div key={t.id} className="l-card plan-small">
              <div className="plan-small-top"><h3>{t.name}</h3><p className="plan-price-sm"><span>{price(t)}</span>{t.priceEurMonth > 0 && " / month"}</p></div>
              <p>{summary(t, frontierLive)}</p>
              <Link href="/chat" className="pill pill-ghost">{t.priceEurMonth > 0 ? `Choose ${t.name}` : "Start free"}</Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const FAQ = [
  ["Can you read my chats?", "Your messages pass through our server in Germany on their way to the enclave. We relay them, but we don't log or store them. Your history is encrypted in your browser, so we never hold a readable copy."],
  ["What is an enclave?", "A sealed area of a processor, here Intel TDX with NVIDIA confidential GPUs, whose memory the host machine cannot read. It produces a signed report of what is running, and this app checks that report."],
  ["What if I lose my browser data?", "Your history is gone unless you exported an encrypted backup. Your plan is safe if you saved a passkey: log in with it on any device."],
  ["Why no email?", "We do not need it. Your account is an opaque id, and a passkey links it across devices."],
  ["Is this GDPR compliant?", "Our server runs in Germany, and we keep only what plans and limits need, and you can download or delete it in one click. The details are in our privacy policy."],
];

export function Faq() {
  return (
    <section id="faq" className="l-wrap l-section l-faq" aria-labelledby="faq-h">
      <h2 id="faq-h" className="h2">Questions</h2>
      <div>{FAQ.map(([q, a]) => <details key={q}><summary>{q}<Plus className="chev" aria-hidden /></summary><p>{a}</p></details>)}</div>
    </section>
  );
}

export function Closing() {
  return (
    <section className="l-closing" aria-label="Get started" data-repel-area>
      <RepelArt src="/brand/narwhal-dots-blue.svg" alt="" cell={1} className="closing-art" />
      <div className="l-wrap closing-in">
        <h2>{gated() ? <>No email.<br />Just an invite.</> : <>No account.<br />No email.</>}</h2>
        <div className="closing-ctas">
          <Link href="/chat" className="pill pill-light lg">{start()} <ArrowRight aria-hidden /></Link>
          <Link href="/privacy/metadata" className="pill pill-outline-light lg">What the server stores</Link>
        </div>
      </div>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className="l-footer">
      <div className="l-wrap foot-row">
        <span className="wordmark"><Mark size={17} />{BRAND}</span>
        <nav aria-label="Legal">
          <Link href="/about" className="navlink">About</Link><Link href="/impressum" className="navlink">Legal notice</Link><Link href="/datenschutz" className="navlink">Privacy</Link>
          <Link href="/agb" className="navlink">Terms</Link><Link href="/privacy/metadata" className="navlink">What the server stores</Link>
        </nav>
        <span className="copy">© 2026 Zoldenburg UG (haftungsbeschränkt)</span>
      </div>
      <div className="l-wrap giant-wrap" aria-hidden><p className="giant">{BRAND}</p></div>
    </footer>
  );
}
