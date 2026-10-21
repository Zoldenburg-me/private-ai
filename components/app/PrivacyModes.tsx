"use client";
import { useEffect, useRef } from "react";
import { EyeSlash, Ghost, LockSimple, MaskHappy, ShieldCheck, X } from "@phosphor-icons/react";

const SECTIONS = [
  { label: "Where the model runs", items: [
    { Icon: ShieldCheck, name: "Private enclave", tag: "TEE", body: "The model runs inside sealed hardware (Intel TDX or AMD SEV-SNP with NVIDIA confidential GPUs). It is built so the machine's owner cannot read its memory; the app checks the enclave's report, but not yet the hardware certificate chain. Replies are signed where the provider supports it.", when: "The default. Pick it for anything sensitive." },
    { Icon: MaskHappy, name: "Incognito · private", tag: "PRIVATE", body: "Open models on a zero-retention route: the provider promises by contract not to keep or train on your data. There's no hardware proof.", when: "When you need a model that isn't available in an enclave." },
    { Icon: EyeSlash, name: "Incognito · anonymized", tag: "ANON", body: "Frontier models like Claude or GPT through a gateway. We strip anything that identifies you before it leaves our relay, but the provider sees the text.", when: "For hard tasks that aren't personal. Has its own daily allowance." },
  ] },
  { label: "Where the chat is kept", items: [
    { Icon: LockSimple, name: "Saved chat", tag: "ENCRYPTED", body: "Your history stays in this browser only, encrypted with a key that never leaves it. Nothing is stored on our servers.", when: "Normal chats. Export a backup to move them." },
    { Icon: Ghost, name: "Ghost chat", tag: "NOT SAVED", body: "Nothing is written anywhere, not even encrypted in your browser. Close the tab and the conversation is gone.", when: "Works with any model above." },
  ] },
];

/** "How private is this chat?": the privacy modes explained, as a modal dialog. */
export function PrivacyModes({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => { const d = ref.current; if (d && !d.open) { opener.current = document.activeElement as HTMLElement | null; d.showModal(); } }, []);
  const closed = () => { onClose(); if (opener.current?.isConnected) opener.current.focus(); };
  return (
    <dialog ref={ref} className="modes" aria-labelledby="modes-h" onClose={closed} onClick={(e) => { if (e.target === ref.current) ref.current.close(); }}>
      <div className="modes-in">
      <div className="modes-head">
        <div>
          <h2 id="modes-h">How private is <em>this chat?</em></h2>
          <p>Two questions: where the model runs, and where the chat is kept.</p>
        </div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={() => ref.current?.close()}><X weight="bold" aria-hidden /></button>
      </div>
      {SECTIONS.map((sec) => (
        <section key={sec.label}>
          <h3>{sec.label}</h3>
          {sec.items.map(({ Icon, name, tag, body, when }) => (
            <div key={name} className="mode">
              <span className="mode-ico"><Icon weight="duotone" aria-hidden /></span>
              <div>
                <div className="mode-name"><span>{name}</span><span className="mode-tag">{tag}</span></div>
                <p>{body}</p>
                <p className="mode-when">{when}</p>
              </div>
            </div>
          ))}
        </section>
      ))}
      <p className="modes-foot">In every mode our relay sees your message in transit and never stores or logs it. Your account is an opaque id with no email.</p>
      </div>
    </dialog>
  );
}
