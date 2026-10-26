"use client";
import { useEffect, type RefObject } from "react";

/** Each child's centre as a fraction of the container's width (x and y both), in child order. */
export type Centres = (els: Element[]) => [number, number][];

/**
 * Children of `ref` near a fine pointer drift away from it and ease back (CSS `translate`, so it composes with
 * other transforms). `cells` is how many cells span the width; the push reaches 5 cells. In an SVG, `translate`
 * is in user units, so `svgWidth` (the viewBox width) converts from screen pixels. `ready` waits for children
 * rendered later. The pointer is tracked on the nearest `[data-repel-area]` ancestor if there is one (for art that
 * sits behind content with pointer-events off). Off for touch and reduced motion.
 */
export function useRepel(ref: RefObject<Element | null>, cells: number, centres: Centres, { svgWidth, ready = true }: { svgWidth?: number; ready?: boolean } = {}) {
  useEffect(() => {
    const box = ref.current;
    if (!ready || !box || !matchMedia("(prefers-reduced-motion: no-preference) and (any-pointer: fine)").matches) return;
    const els = [...box.children].filter((c) => !c.hasAttribute("data-norepel")) as (HTMLElement | SVGElement)[];
    const pts = centres(els);
    const moved = new Uint8Array(els.length); // only dots that are or were pushed get a style write
    let frame = 0, cx = 0, cy = 0, inside = false;
    const paint = () => {
      frame = 0;
      const r = box.getBoundingClientRect(), cell = r.width / cells, reach = cell * 5;
      const unit = svgWidth ? svgWidth / r.width : 1; // screen px -> the units `translate` uses here
      els.forEach((el, i) => {
        const dx = pts[i][0] * r.width - (cx - r.left), dy = pts[i][1] * r.width - (cy - r.top);
        const dist = Math.hypot(dx, dy), push = inside && dist < reach ? (1 - dist / reach) * cell * 1.6 / (dist || 1) : 0;
        if (!push && !moved[i]) return;
        el.style.translate = push ? `${(dx * push * unit).toFixed(2)}px ${(dy * push * unit).toFixed(2)}px` : "";
        moved[i] = push ? 1 : 0;
      });
    };
    const move = (e: Event) => {
      const p = e as PointerEvent;
      if (p.pointerType === "touch") return;
      cx = p.clientX; cy = p.clientY; inside = p.type === "pointermove";
      frame ||= requestAnimationFrame(paint);
    };
    const area = box.closest("[data-repel-area]") ?? box;
    area.addEventListener("pointermove", move);
    area.addEventListener("pointerleave", move);
    return () => { area.removeEventListener("pointermove", move); area.removeEventListener("pointerleave", move); cancelAnimationFrame(frame); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
}
