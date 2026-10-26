import Link from "next/link";
import "../landing.css";
import { BRAND, SiteFooter, SiteNav, gated } from "@/components/landing/Sections";
import { COMPANY } from "@/components/legal";
import { DotField } from "@/components/landing/DotField";
import { RepelArt } from "@/components/landing/RepelArt";

// Always per request: the invite-gate copy (INVITE_CODES) must never be frozen at build time.
export const dynamic = "force-dynamic";

export const metadata = {
  title: `About · ${BRAND}`,
  description: "Why we built an AI chat that keeps as little about you as possible, how we work, and who builds it.",
};

const rules = () => [
  { title: "Prove it, do not promise it", body: "Max Privacy runs in hardware enclaves whose attestation the app checks before you chat. You can read the proof yourself." },
  { title: "Keep nothing we do not need", body: "The server holds an opaque id, your plan, timestamps and counters. No prompts, no replies, no IP addresses, no emails." },
  gated()
    ? { title: "No email, ever", body: "During the beta you start with an invite, not an email address. Add a passkey if you want your plan on more than one device." }
    : { title: "No account by default", body: "Start chatting without signing up. Add a passkey later if you want your plan on more than one device." },
  { title: "Say what we cannot check", body: "We verify the enclave, not what the model writes. Zero retention in Private mode is a contract, and we label it that way." },
];

const TEAM = [
  { name: "Tony Thomas", role: "Founder", img: "/brand/team/tony-thomas.svg", alt: "Halftone portrait of Tony Thomas" },
  { name: "Claude", role: "AI teammate · Anthropic", img: "/brand/team/claude.svg", alt: "Halftone robot with the Claude spark on its antenna", x: "https://x.com/claudeai" },
];

const FACTS = [
  { k: "Company", v: COMPANY.name },
  { k: "Based in", v: "Germany" },
  { k: "Confidential compute from", v: "NEAR AI, Phala, Tinfoil" },
];

const pad = (i: number) => String(i + 1).padStart(2, "0");

export default function About() {
  return (
    <div className="landing">
      <SiteNav current="/about" />
      <main id="top">
        <section className="l-wrap a-hero" aria-labelledby="about-h">
          <div className="rise">
            <h1 id="about-h">We built the AI chat we wanted to use.</h1>
            <p className="lead">Most AI chats keep what you type, tie it to your email and read it to improve their models. {BRAND} started from the opposite question: how little can we know about you and still run a good assistant?</p>
          </div>
          <figure>
            <RepelArt src={TEAM[0].img} alt={TEAM[0].alt} cell={10} />
            <figcaption><b>{TEAM[0].name}</b> · {TEAM[0].role}</figcaption>
          </figure>
        </section>

        <section className="a-why" aria-labelledby="why-h">
          <div className="l-wrap a-split">
            <h2 id="why-h" className="h2">Why it exists</h2>
            <div>
              <p>People ask AI the things they would not type into a search bar: a scan result, a money worry, a draft they are not ready to send. That should not end up in someone&rsquo;s training set or support dashboard.</p>
              <p>So we run open models inside sealed hardware, keep your history encrypted on your own device, and skip the account entirely. When we cannot prove something, we say so.</p>
            </div>
          </div>
        </section>

        <section className="l-wrap a-rules" aria-labelledby="rules-h">
          <h2 id="rules-h" className="h2">How we work</h2>
          <ol>
            {rules().map((r, i) => <li key={r.title}><span className="a-n">{pad(i)}</span><span className="a-t">{r.title}</span><span className="a-b">{r.body}</span></li>)}
          </ol>
        </section>

        <section id="team" className="l-wrap a-team" aria-labelledby="team-h">
          <div className="a-team-head">
            <h2 id="team-h" className="h2">Team</h2>
            <p>The people, and the model, building it</p>
          </div>
          <ul>
            {TEAM.map((p, i) => (
              <li key={p.name}>
                <div className="a-photo">
                  <RepelArt src={p.img} alt={p.alt} cell={10} />
                  <span>[ {pad(i)} ]</span>
                </div>
                <div className="a-card-foot">
                  <div><div className="a-name">{p.name}</div><div className="a-role">{p.role}</div></div>
                  {p.x && (
                    <a href={p.x} aria-label={`${p.name} on X`} rel="noopener noreferrer" target="_blank">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.4L5.3 21H2.2l7.2-8.3L2 3h6.4l4.4 5.8zm-1.1 16.2h1.7L7.4 4.7H5.6z" /></svg>
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="a-facts" aria-label="Company">
          <DotField />
          <div className="l-wrap">
            {FACTS.map((f) => <div key={f.k}><div className="a-k">{f.k}</div><div className="a-v">{f.v}</div></div>)}
          </div>
        </section>

        <section className="l-wrap a-contact" aria-labelledby="contact-h">
          <h2 id="contact-h">Questions, press or a privacy concern?</h2>
          <div>
            <a href={`mailto:${COMPANY.email}`} className="pill pill-ghost lg">Write to us</a>
            <Link href="/chat" className="pill pill-ink lg">Start chatting</Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
