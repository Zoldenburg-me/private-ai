"use client";
import { useEffect, useState } from "react";
import { Pause, Play } from "@phosphor-icons/react";

/** Is the hero's background motion paused? Read every frame by HeroSky and HeroSilk. */
export const motionPaused = () => document.documentElement.dataset.motion === "paused";

/** Pause/resume for the hero's looping background motion (WCAG 2.2.2). The CSS loops key off the same attribute. */
export function MotionToggle() {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) document.documentElement.dataset.motion = "paused";
    else delete document.documentElement.dataset.motion;
  }, [paused]);
  useEffect(() => () => { delete document.documentElement.dataset.motion; }, []);
  return (
    <button type="button" className="motion-toggle" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
      {paused ? <Play weight="fill" aria-hidden /> : <Pause weight="fill" aria-hidden />}
      Pause background
    </button>
  );
}
