"use client";
import { useSyncExternalStore } from "react";

/** One note: frequency (Hz), length (s), waveform, peak gain. */
export type Note = readonly [hz: number, seconds: number, type?: OscillatorType, gain?: number];

// Off by default and kept in memory only: the landing page writes nothing to browser storage.
let on = false;
const listeners = new Set<() => void>();
let ctx: AudioContext | null = null;

export const soundOn = () => on;
export function setSound(next: boolean) {
  on = next;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useSound = () => useSyncExternalStore(subscribe, soundOn, () => false);

/**
 * Synthesised tones (WebAudio, no files). Silent unless the visitor turned sound on; `force` is the toggle's own
 * confirmation, played from the click that turned it on.
 */
export function tone(notes: readonly Note[], force = false) {
  if (!on && !force) return;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const c = (ctx ??= new AC());
    let t = c.currentTime;
    for (const [hz, len, type = "sine", gain = 0.05] of notes) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g); g.connect(c.destination);
      o.start(t); o.stop(t + len + 0.03);
      t += len * 0.55;
    }
  } catch { /* no audio device: stay silent */ }
}

export const TONES = {
  soundOn: [[880, 0.08], [1320, 0.14]],
  seal: [[523, 0.12], [784, 0.16], [1047, 0.3]],
  unseal: [[1047, 0.12], [784, 0.16], [523, 0.3]],
} satisfies Record<string, readonly Note[]>;
