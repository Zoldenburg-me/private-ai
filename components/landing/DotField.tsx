"use client";
import { useEffect, useRef } from "react";

/**
 * A grid of dots drawn on a canvas that fills its positioned parent, behind the content. Dots near a fine pointer
 * drift away from it and ease back, like the hero narwhal. The dot colour is the canvas's CSS `color`, so it follows
 * the theme. `bleed` extends the canvas past the parent so pushed dots are not clipped; the pointer is tracked on the
 * nearest `[data-repel-area]` ancestor if there is one. Static under reduced motion or touch-only input.
 */
export function DotField({ gapX = 16, gapY = gapX, r = 1.5, bleed = 0, className = "" }: { gapX?: number; gapY?: number; r?: number; bleed?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current, box = cv?.parentElement, ctx = cv?.getContext("2d");
    if (!cv || !box || !ctx) return;
    const area = cv.closest("[data-repel-area]") ?? box;
    const live = matchMedia("(prefers-reduced-motion: no-preference) and (any-pointer: fine)").matches;
    let w = 0, h = 0, cols = 0, rows = 0, off = new Float32Array(0), frame = 0, px = 0, py = 0, inside = false;

    const draw = () => {
      frame = 0;
      const reach = Math.max(gapX, gapY) * 5, max = Math.max(gapX, gapY) * 1.6;
      let moving = false;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = getComputedStyle(cv).color;
      ctx.beginPath();
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const k = (j * cols + i) * 2, x = bleed + (i + .5) * gapX, y = bleed + (j + .5) * gapY;
          let tx = 0, ty = 0;
          if (inside) {
            const dx = x - px, dy = y - py, d = Math.hypot(dx, dy);
            if (d < reach) { const p = (1 - d / reach) * max / (d || 1); tx = dx * p; ty = dy * p; }
          }
          // Ease toward the target, like the CSS `translate` transition on the narwhal's dots.
          off[k] += (tx - off[k]) * .18; off[k + 1] += (ty - off[k + 1]) * .18;
          if (Math.abs(tx - off[k]) > .05 || Math.abs(ty - off[k + 1]) > .05) moving = true;
          ctx.moveTo(x + off[k] + r, y + off[k + 1]);
          ctx.arc(x + off[k], y + off[k + 1], r, 0, Math.PI * 2);
        }
      }
      ctx.fill();
      if (moving) frame = requestAnimationFrame(draw);
    };
    const size = () => {
      const dpr = devicePixelRatio || 1;
      cols = Math.ceil(box.clientWidth / gapX); rows = Math.ceil(box.clientHeight / gapY);
      w = box.clientWidth + bleed * 2; h = box.clientHeight + bleed * 2;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`; cv.style.height = `${h}px`; // a canvas is not stretched by inset
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      off = new Float32Array(cols * rows * 2);
      cancelAnimationFrame(frame); draw();
    };
    const move = (ev: Event) => {
      const e = ev as PointerEvent;
      if (e.pointerType === "touch") return;
      const b = cv.getBoundingClientRect();
      px = e.clientX - b.left; py = e.clientY - b.top; inside = e.type === "pointermove";
      frame ||= requestAnimationFrame(draw);
    };
    const ro = new ResizeObserver(size);
    ro.observe(box);
    // Redraw when the theme flips (the colour comes from CSS).
    const mq = matchMedia("(prefers-color-scheme: dark)"), mo = new MutationObserver(() => draw());
    mq.addEventListener("change", size);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    if (live) { area.addEventListener("pointermove", move); area.addEventListener("pointerleave", move); }
    return () => {
      ro.disconnect(); mo.disconnect(); mq.removeEventListener("change", size); cancelAnimationFrame(frame);
      area.removeEventListener("pointermove", move); area.removeEventListener("pointerleave", move);
    };
  }, [gapX, gapY, r, bleed]);

  return <canvas ref={ref} className={`dotfield-canvas ${className}`} style={bleed ? { inset: -bleed } : undefined} aria-hidden />;
}
