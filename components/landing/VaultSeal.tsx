"use client";
import { useEffect, useRef, useState } from "react";
import { LockSimple, LockSimpleOpen } from "@phosphor-icons/react";
import { TONES, tone } from "./sound";

export const SAMPLE = "You: My ferritin came back at 9. Should I be worried? Hiddensee: That is below the usual range, which often points to low iron stores. It is worth asking your doctor about...";
/** Shown before hydration; replaced on mount by a real AES-256-GCM encryption of SAMPLE, in the vault's own format. */
const PLACEHOLDER = "enc1:kQ7v2Xc9LmR0pZ+aE4tYw1Hn8sGdUo3JfB6yKiV5qNxlMz/CgTrP0bWeS2hA7uO9jD1cF4vX8mL3nQ6kRz+Ty5wHgJ0pBsUaEiMd2fK7oVxN9lCbr4qYt1eZ3hW8gS6uP/AjD0nF5mXkL2vRc7iQ9oT4yGzH+wBe1sU8aJpN3dM6lK0fV5xCqYr2hE7tO9gZ4bWnS1iD8uP3jA6cL+mX0vR5k";
const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const STEPS = 28;

/** "enc1:" + base64(iv || ciphertext), like lib/client/vault.ts, with a throwaway key that lives in this tab only. */
async function seal(text: string): Promise<string> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)));
  const all = new Uint8Array(iv.length + ct.length);
  all.set(iv); all.set(ct, iv.length);
  return "enc1:" + btoa(String.fromCharCode(...all));
}

/** The vault band's demo: the same chat as stored (sealed) or in plain text, with a left-to-right scramble between them. */
export function VaultSeal() {
  const [sealed, setSealed] = useState(true);
  const [cipher, setCipher] = useState(PLACEHOLDER);
  const [frame, setFrame] = useState<string | null>(null); // mid-scramble text
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    seal(SAMPLE).then(setCipher, () => { /* no WebCrypto (plain http): keep the placeholder */ });
    return () => clearInterval(timer.current);
  }, []);

  const flip = () => {
    const toSealed = !sealed, to = toSealed ? cipher : SAMPLE;
    tone(toSealed ? TONES.seal : TONES.unseal);
    clearInterval(timer.current);
    setSealed(toSealed);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { setFrame(null); return; }
    let step = 0;
    timer.current = setInterval(() => {
      step++;
      const cut = Math.floor((to.length * step) / STEPS);
      let out = to.slice(0, cut);
      for (let i = cut; i < to.length; i++) out += to[i] === " " ? " " : ABC[Math.floor(Math.random() * ABC.length)];
      if (step >= STEPS) { clearInterval(timer.current); setFrame(null); } else setFrame(out);
    }, 40);
  };

  return (
    <div className="vault-dark">
      <p className="vault-label">{sealed ? "The same chat, as your browser stores it" : "The same chat, if it were stored unencrypted"}</p>
      {/* The scramble frames are decorative; screen readers get the settled state only. */}
      <p className={`vault-text ${sealed ? "sealed" : ""}`} aria-hidden>{frame ?? (sealed ? cipher : SAMPLE)}</p>
      <p className="sr-only" aria-live="polite">{sealed ? "Shown encrypted." : `Shown in plain text: ${SAMPLE}`}</p>
      <p className="vault-note">Encrypted with AES-256-GCM. The key never leaves this device, and our servers keep no copy.</p>
      <button type="button" className="pill pill-outline-light" onClick={flip}>
        {sealed ? <LockSimpleOpen aria-hidden /> : <LockSimple aria-hidden />}
        {sealed ? "Show it unsealed" : "Seal it again"}
      </button>
    </div>
  );
}
