"use client";
import { useEffect, useRef, useState } from "react";
import { useRepel, type Centres } from "./repel";

// Our own dot and halftone SVGs (scripts/halftone-portrait.mjs, scripts/narwhal-dot-body.mjs): a viewBox, an
// optional full-size background rect or grid path, and one rect or circle per cell. Only these attributes are kept.
type Shape = { tag: "rect" | "circle" | "path"; a: Record<string, string>; still: boolean };
const KEEP = ["x", "y", "width", "height", "cx", "cy", "r", "d", "fill", "stroke"];

const num = (el: Element, k: string) => Number(el.getAttribute(k) ?? 0);
const centres = (vbw: number): Centres => (els) => els.map((el) => el.tagName === "circle"
  ? [num(el, "cx") / vbw, num(el, "cy") / vbw]
  : [(num(el, "x") + num(el, "width") / 2) / vbw, (num(el, "y") + num(el, "height") / 2) / vbw]);

/**
 * Dot art whose dots drift away from the pointer, like the hero narwhal. `cell` is the dot pitch in viewBox units.
 * Shows the plain image until the SVG is loaded and parsed. `alt=""` makes it decorative.
 */
export function RepelArt({ src, alt, cell, className }: { src: string; alt: string; cell: number; className?: string }) {
  const [art, setArt] = useState<{ vb: number[]; shapes: Shape[] } | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const vbw = art?.vb[2] ?? 1;
  useRepel(ref, vbw / cell, centres(vbw), { svgWidth: vbw, ready: !!art });

  useEffect(() => {
    let live = true;
    setArt(null);
    fetch(src).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))).then((text) => {
      const svg = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
      const vb = (svg.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
      if (vb.length !== 4 || vb.some(Number.isNaN)) return;
      const shapes: Shape[] = [...svg.querySelectorAll("rect, circle, path")].map((el) => {
        const a: Record<string, string> = {};
        KEEP.forEach((k) => { const v = el.getAttribute(k); if (v !== null) a[k] = v; });
        const sw = el.getAttribute("stroke-width"); if (sw) a.strokeWidth = sw;
        // The background and the grid lines stay put.
        const still = el.tagName === "path" || (el.tagName === "rect" && num(el, "width") >= vb[2]);
        return { tag: el.tagName as Shape["tag"], a, still };
      });
      if (live && shapes.length) setArt({ vb, shapes });
    }).catch(() => { /* keep the plain image */ });
    return () => { live = false; };
  }, [src]);

  if (!art) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} className={className} aria-hidden={alt ? undefined : true} />;
  }
  const label = alt ? { role: "img", "aria-label": alt } : { "aria-hidden": true };
  return (
    <svg ref={ref} className={`repel-art ${className ?? ""}`} viewBox={art.vb.join(" ")} shapeRendering={art.shapes.some((s) => s.tag === "rect" && !s.still) ? "crispEdges" : undefined} {...label}>
      {art.shapes.map(({ tag: Tag, a, still }, i) => <Tag key={i} {...a} {...(still ? { "data-norepel": "" } : {})} />)}
    </svg>
  );
}
