/** One note: frequency (Hz), length (s), waveform, peak gain. */
export type Note = readonly [hz: number, seconds: number, type?: OscillatorType, gain?: number];

let ctx: AudioContext | null = null;

/** Plays a short synthesised phrase with WebAudio (no audio files). Callers decide whether sound is on. */
export function playNotes(notes: readonly Note[]) {
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
