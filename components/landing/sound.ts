"use client";
import { useSyncExternalStore } from "react";
import { playNotes, type Note } from "@/lib/client/tone";

// Off by default and kept in memory only: the landing page writes nothing to browser storage.
let on = false;
const listeners = new Set<() => void>();

export const soundOn = () => on;
export function setSound(next: boolean) {
  on = next;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useSound = () => useSyncExternalStore(subscribe, soundOn, () => false);

/** Silent unless the visitor turned sound on; `force` is the toggle's own confirmation, played from the click that turned it on. */
export function tone(notes: readonly Note[], force = false) {
  if (on || force) playNotes(notes);
}

export const TONES = {
  soundOn: [[880, 0.08], [1320, 0.14]],
  seal: [[523, 0.12], [784, 0.16], [1047, 0.3]],
  unseal: [[1047, 0.12], [784, 0.16], [523, 0.3]],
} satisfies Record<string, readonly Note[]>;
