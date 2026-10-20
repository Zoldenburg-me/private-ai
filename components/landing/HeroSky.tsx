"use client";
import { useEffect, useRef } from "react";
import { motionPaused } from "./MotionToggle";

/**
 * Night lake behind the hero: twinkling stars and an occasional shooting star above the horizon,
 * moonlight glinting on the water below it.
 * Pauses off screen and on the pause button; one still frame under reduced motion. Decorative, hidden from assistive tech.
 */
const STAR_DENSITY = 1 / 2600; // stars per CSS pixel of area, at first size
const MAX_STARS = 900;
const MAX_PIXELS = 8e6; // keep the backing store under browser canvas limits
const FRAME_MS = 1000 / 30; // twinkle looks the same at 30 fps and halves the work
const SHOOT_EVERY_MS = 5200;
const SHOOT_MS = 900;
const SHOOT_DX = -Math.cos(.5), SHOOT_DY = Math.sin(.5);
/** Horizon as a fraction of the hero's height; must match the .lake gradient in landing.css. */
const HORIZON = .58;
const GLINTS_PER_PX = .6; // glints per CSS pixel of width
const MAX_GLINTS = 600;

/** Positions are 0..1 of the canvas, so a resize rescales the sky instead of reshuffling it. */
type Star = { x: number; y: number; r: number; phase: number; speed: number; blue: boolean };

function makeStars(count: number): Star[] {
  return Array.from({ length: count }, () => {
    const big = Math.random() < .08;
    return {
      x: Math.random(),
      y: Math.random() * (HORIZON - .03),
      r: big ? 1.4 + Math.random() : .4 + Math.random() * .7,
      phase: Math.random() * Math.PI * 2,
      speed: .4 + Math.random() * 1.2,
      blue: big,
    };
  });
}

/** Moonlight on the water: x, y as 0..1 of the canvas; depth 0 at the horizon, 1 at the bottom edge. */
type Glint = { x: number; y: number; depth: number; len: number; phase: number; speed: number; path: boolean };

function makeGlints(count: number): Glint[] {
  return Array.from({ length: count }, () => {
    const depth = Math.random() ** 1.4;
    const path = Math.random() < .7; // the moon's path; the rest scatter faintly across the lake
    const spread = path ? .015 + depth * .16 : .5;
    const offset = (Math.random() + Math.random() + Math.random() - 1.5) * spread * 1.4;
    return {
      x: .5 + offset, y: HORIZON + depth * (1 - HORIZON), depth, path,
      len: 2 + (4 + depth * 30) * Math.random(),
      phase: Math.random() * Math.PI * 2, speed: 1 + Math.random() * 2.5,
    };
  });
}

export function HeroSky() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let stars: Star[] = [], glints: Glint[] = [];
    let w = 0, h = 0;
    const size = () => {
      const r = canvas.getBoundingClientRect();
      if (Math.round(r.width) === Math.round(w) && Math.round(r.height) === Math.round(h)) return false;
      w = r.width; h = r.height;
      const dpr = Math.min(devicePixelRatio || 1, 2, Math.sqrt(MAX_PIXELS / Math.max(1, w * h)));
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Top up when the hero grows (e.g. first measured on a phone); existing stars keep their places.
      const target = Math.min(MAX_STARS, Math.round(w * h * STAR_DENSITY));
      if (target > stars.length) stars = stars.concat(makeStars(target - stars.length));
      const gTarget = Math.min(MAX_GLINTS, Math.round(w * GLINTS_PER_PX));
      if (gTarget > glints.length) glints = glints.concat(makeGlints(gTarget - glints.length));
      return true;
    };
    let shoot: { x: number; y: number; start: number } | null = null;
    let nextShoot = 1500;

    const draw = (ms: number, withShoot: boolean) => {
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        ctx.globalAlpha = .35 + .65 * (.5 + .5 * Math.sin(ms / 1000 * s.speed + s.phase));
        ctx.fillStyle = s.blue ? "#cfe0ff" : "#ffffff";
        ctx.beginPath(); ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2); ctx.fill();
      }
      // No ctx.filter blur here: it runs one blur pass per shape, measured at ~5 s a frame on a retina hero.
      for (const g of glints) {
        const on = Math.max(0, Math.sin(ms / 1000 * g.speed + g.phase));
        ctx.globalAlpha = on * on * (g.path ? .85 - g.depth * .35 : .25);
        ctx.fillStyle = g.path ? "#f4e6c8" : "#a9bde3";
        const sway = Math.sin(ms / 1400 + g.phase) * 2;
        ctx.fillRect(g.x * w + sway - g.len / 2, g.y * h, g.len, 1 + g.depth * 1.2);
      }
      if (withShoot && !shoot && ms > nextShoot) shoot = { x: w * (.3 + Math.random() * .6), y: h * Math.random() * .35, start: ms };
      if (shoot) {
        const t = (ms - shoot.start) / SHOOT_MS;
        if (t >= 1 || !withShoot) { shoot = null; nextShoot = ms + SHOOT_EVERY_MS * (.6 + Math.random() * .8); }
        else {
          const travel = Math.min(320, w * .4), len = Math.min(140, w * .18);
          const hx = shoot.x + SHOOT_DX * t * travel, hy = shoot.y + SHOOT_DY * t * travel;
          const g = ctx.createLinearGradient(hx, hy, hx - SHOOT_DX * len, hy - SHOOT_DY * len);
          g.addColorStop(0, "rgba(255,255,255,.9)"); g.addColorStop(1, "rgba(255,255,255,0)");
          ctx.globalAlpha = Math.sin(t * Math.PI); ctx.strokeStyle = g; ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx - SHOOT_DX * len, hy - SHOOT_DY * len); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    };

    size();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      draw(0, false);
      const ro = new ResizeObserver(() => { if (size()) draw(0, false); });
      ro.observe(canvas);
      return () => ro.disconnect();
    }
    let raf = 0, last = 0;
    const loop = (ms: number) => {
      if (ms - last >= FRAME_MS && !motionPaused()) { last = ms; draw(ms, true); }
      raf = requestAnimationFrame(loop);
    };
    const io = new IntersectionObserver((entries) => {
      const visible = entries[entries.length - 1]?.isIntersecting;
      if (visible && !raf) raf = requestAnimationFrame(loop);
      if (!visible) { cancelAnimationFrame(raf); raf = 0; }
    });
    // Redraw at once after a resize, so the cleared bitmap never shows (even while paused).
    const ro = new ResizeObserver(() => { if (size()) draw(last, false); });
    io.observe(canvas); ro.observe(canvas);
    return () => { io.disconnect(); ro.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  return <canvas ref={ref} className="sky" aria-hidden />;
}
