"use client";

import { useEffect, useRef } from "react";

// The narwhal mark sampled at 46x19 and set into a 52x27 dot field: # body, + edge, . soft edge, t tusk (a t left of
// column 30 is the eye, left empty). Each inked dot resolves out of the field after a pseudo-random delay (landing.css),
// and dots near a fine pointer drift away from it and ease back (CSS `translate`, so it composes with the resolve transform).
const BMP = [
  "                                           .t.",
  "                                          +t+ ",
  "                     .++++++..          .tt.  ",
  "                .+##############+      +tt.   ",
  "              +###################.  .tt+     ",
  "            +######################++#t.      ",
  "          .###########################.       ",
  " ++.     .###########################         ",
  " +##+  .+###########ttt##############         ",
  "  ##################t#t##############         ",
  "  ##################tt###############         ",
  "  ###################t##############+         ",
  " +##+  .+##########################+          ",
  " ++.     .+#######################+           ",
  "            +####################.            ",
  "               ++#############+.              ",
  "                   +##.....                   ",
  "                   ##+                        ",
  "                  .+.                         ",
];
const COLS = 52, ROWS = 27, OX = 3, OY = 4;
const KIND: Record<string, string> = { "#": "k-full", "+": "k-mid", ".": "k-low", t: "k-tusk" };

const DOTS: string[] = [];
for (let y = 0; y < ROWS; y++) {
  for (let x = 0; x < COLS; x++) {
    const ch = BMP[y - OY]?.charAt(x - OX) || " ";
    const k = ch === "t" && x - OX < 30 ? "k-eye" : KIND[ch] ?? "";
    const wave = Math.abs(Math.floor(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453)) % 10;
    DOTS.push(k && k !== "k-eye" ? `dot ${k} w${wave}` : `dot ${k}`.trim());
  }
}

/** The hero's small dot narwhal (decorative). */
export function DotNarwhal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const grid = ref.current;
    if (!grid || !matchMedia("(prefers-reduced-motion: no-preference) and (pointer: fine)").matches) return;
    const dots = [...grid.children] as HTMLElement[];
    let frame = 0, cx = 0, cy = 0, inside = false;
    const paint = () => {
      frame = 0;
      const r = grid.getBoundingClientRect(), cell = r.width / COLS, reach = cell * 5;
      dots.forEach((d, i) => {
        const dx = (i % COLS + .5) * cell - (cx - r.left), dy = (Math.floor(i / COLS) + .5) * cell - (cy - r.top);
        const dist = Math.hypot(dx, dy), push = inside && dist < reach ? (1 - dist / reach) * cell * 1.6 / (dist || 1) : 0;
        d.style.translate = push ? `${(dx * push).toFixed(1)}px ${(dy * push).toFixed(1)}px` : "";
      });
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      cx = e.clientX; cy = e.clientY; inside = e.type === "pointermove";
      frame ||= requestAnimationFrame(paint);
    };
    grid.addEventListener("pointermove", move);
    grid.addEventListener("pointerleave", move);
    return () => { grid.removeEventListener("pointermove", move); grid.removeEventListener("pointerleave", move); cancelAnimationFrame(frame); };
  }, []);
  return <div ref={ref} className="dot-narwhal" aria-hidden>{DOTS.map((c, i) => <span key={i} className={c} />)}</div>;
}
