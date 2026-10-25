"use client";
import { SpeakerHigh, SpeakerX } from "@phosphor-icons/react";
import { TONES, setSound, tone, useSound } from "./sound";

/** Opt-in interface sounds for the landing page. Off on every visit. */
export function SoundToggle() {
  const on = useSound();
  const label = on ? "Turn sound off" : "Turn sound on";
  const flip = () => { setSound(!on); if (!on) tone(TONES.soundOn, true); };
  return (
    <button type="button" className="sound-btn" aria-pressed={on} aria-label={label} title={label} onClick={flip}>
      {on ? <SpeakerHigh aria-hidden /> : <SpeakerX aria-hidden />}
    </button>
  );
}
