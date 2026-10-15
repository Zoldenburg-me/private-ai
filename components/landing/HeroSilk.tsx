"use client";
import { useEffect, useRef } from "react";

/**
 * Slow silk band behind the hero, ported from the Amber Study HeroSilk component.
 * Colours come from the --art-* tokens. Pauses off screen; one still frame under reduced motion;
 * a radial glow when WebGL is unavailable. Purely decorative, so it is hidden from assistive tech.
 */
const FRAG = `
precision mediump float;
uniform vec2 res; uniform float t;
uniform vec3 cA, cB, cC, cD, cR;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float v = 0., a = .5; for (int i = 0; i < 4; i++){ v += a*noise(p); p *= 2.; a *= .5; } return v; }
void main(){
  vec2 uv = gl_FragCoord.xy / res;
  float x = uv.x * res.x / res.y;
  float w = .30 + .07*sin(x*1.2 + t*.22) + .04*sin(x*2.9 - t*.17) + .06*(fbm(vec2(x*.7, t*.04)) - .5);
  float d = uv.y - w;
  float body = exp(-d*d*90.) * .55;
  float glow = exp(-d*d*14.) * .18;
  float f1 = exp(-pow(d + .020, 2.) * 3200.);
  float f2 = exp(-pow(d - .030 - .020*sin(x*3.1 + t*.30), 2.) * 1400.) * .55;
  float f3 = exp(-pow(d - .075 - .030*sin(x*1.7 - t*.24), 2.) * 700.) * .35;
  float crease = .35 + .65 * smoothstep(-.6, .9, sin(x*5.5 + d*55. + t*.35 + fbm(vec2(x*2., t*.1))*3.));
  float hue = fbm(vec2(x*.5 + t*.02, uv.y*1.6));
  float side = smoothstep(.25, .75, uv.x + (hue - .5) * .5 + .06*sin(t*.15));
  vec3 col = mix(cA, cB, side);
  col = mix(col, cC, smoothstep(.55, .85, hue) * .7);
  col = mix(col, cD, smoothstep(.38, .22, hue) * (1. - side) * .5);
  vec3 c = col * (body*crease + glow + f2*crease + f3) + mix(cR, col, .35) * f1 * (.5 + .5*crease);
  c *= 1. - smoothstep(.42, .72, uv.y);
  gl_FragColor = vec4(c, 1.);
}`;
const VERT = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
const UNIFORMS = [["cA", "art-a"], ["cB", "art-b"], ["cC", "art-c"], ["cD", "art-d"], ["cR", "art-ridge"]] as const;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.trim().replace("#", "");
  const n = parseInt(h.length === 3 ? [...h].map((c) => c + c).join("") : h, 16);
  return Number.isNaN(n) ? [0, 0, 0] : [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function HeroSilk() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`);
    const fallback = () => { canvas.style.background = `radial-gradient(60% 40% at 40% 80%, ${token("art-a")}, transparent 70%)`; };
    const gl = canvas.getContext("webgl");
    if (!gl) { fallback(); return; }

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const prog = gl.createProgram()!;
    try { gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog); }
    catch { fallback(); return; }
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    UNIFORMS.forEach(([u, t]) => gl.uniform3fv(gl.getUniformLocation(prog, u), hexToRgb(token(t))));
    const uRes = gl.getUniformLocation(prog, "res"); const uT = gl.getUniformLocation(prog, "t");

    // Half resolution: the CSS blur hides it and it halves the fragment cost.
    const size = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * .5)); canvas.height = Math.max(1, Math.round(r.height * .5));
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    const draw = (ms: number) => { gl.uniform2f(uRes, canvas.width, canvas.height); gl.uniform1f(uT, ms / 1000); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); };
    size();

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const still = () => { size(); draw(12000); };
      still(); addEventListener("resize", still);
      return () => removeEventListener("resize", still);
    }
    let raf = 0;
    const loop = (ms: number) => { draw(ms); raf = requestAnimationFrame(loop); };
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !raf) raf = requestAnimationFrame(loop);
      if (!e.isIntersecting) { cancelAnimationFrame(raf); raf = 0; }
    });
    io.observe(canvas);
    addEventListener("resize", size);
    return () => { io.disconnect(); cancelAnimationFrame(raf); removeEventListener("resize", size); };
  }, []);

  return <canvas ref={ref} className="silk" aria-hidden />;
}
