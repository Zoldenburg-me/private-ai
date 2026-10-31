/**
 * Prototype of Clips (docs/clip-spec.md): a video file or YouTube link plus a plain-language request in, vertical clips out.
 *   npx vite-node scripts/clip-prototype.ts -- (--file in.mp4 | --url https://youtu.be/…) --ask "3 punchy clips" --model <id> [--out clips]
 * Needs ffmpeg, yt-dlp (for --url) and uv (runs faster-whisper via whisper-ctranslate2, and OpenCV for scripts/clip-frame.py). The picking model is any
 * OpenAI-compatible endpoint: CLIP_BASE_URL (default http://127.0.0.1:3000/api/v1, Hiddensee) and CLIP_API_KEY
 * (default: a fresh anonymous Hiddensee session). Temp files are deleted at the end; only the clips stay in --out.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LIMITS, PICK_SYSTEM, captionsSrt, cutArgs, parsePicks, transcriptForModel, youtubeUrl, type Frame, type Segment } from "../lib/clip";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const BASE = process.env.CLIP_BASE_URL ?? "http://127.0.0.1:3000/api/v1";
const WHISPER_MODEL = process.env.CLIP_WHISPER_MODEL ?? "small";
const run = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString();
const step = (s: string) => console.error(`· ${s}`);

async function apiKey(): Promise<string> {
  if (process.env.CLIP_API_KEY) return process.env.CLIP_API_KEY;
  const s = await (await fetch(`${new URL(BASE).origin}/api/session`)).json() as { apiToken?: string };
  if (!s.apiToken) throw new Error("no apiToken from /api/session; set CLIP_API_KEY");
  return s.apiToken;
}

async function pick(segs: Segment[], ask: string, model: string) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await apiKey()}` }, signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({ model, temperature: 0.2, messages: [
      { role: "system", content: PICK_SYSTEM },
      { role: "user", content: `Request: ${ask}\n\nTranscript:\n${transcriptForModel(segs)}` },
    ] }),
  });
  if (!res.ok) throw new Error(`picking model: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
}

async function main() {
  const ask = arg("ask"), model = arg("model") ?? process.env.CLIP_MODEL, file = arg("file"), url = arg("url");
  if (!ask || !model || !(file || url)) throw new Error("usage: --file in.mp4 | --url <youtube link>, --ask \"…\", --model <id>");
  const out = resolve(arg("out") ?? "clips");
  const tmp = mkdtempSync(join(tmpdir(), "clip-"));
  try {
    let src = file ? resolve(file) : "";
    if (url) {
      const yt = youtubeUrl(url);
      if (!yt) throw new Error("only YouTube links are accepted");
      step("downloading");
      run("yt-dlp", ["--no-playlist", "--quiet", "--match-filter", `duration<=${LIMITS.maxSourceS}`, "-f", "bv*[height<=1080]+ba/b[height<=1080]",
        "--merge-output-format", "mp4", "-o", join(tmp, "src.%(ext)s"), yt]);
      const got = readdirSync(tmp).find((f) => f.startsWith("src."));
      if (!got) throw new Error(`video not downloaded (longer than ${LIMITS.maxSourceS / 3600} h, private, or blocked)`);
      src = join(tmp, got);
    }
    const duration = Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src]));
    if (!(duration > 0) || duration > LIMITS.maxSourceS) throw new Error(`source must be 0-${LIMITS.maxSourceS} s, is ${duration}`);

    step(`transcribing ${Math.round(duration)} s with whisper ${WHISPER_MODEL}`);
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000", join(tmp, "audio.wav")]);
    run("uvx", ["whisper-ctranslate2", join(tmp, "audio.wav"), "--model", WHISPER_MODEL, "--word_timestamps", "True",
      "--output_format", "json", "--output_dir", tmp, "--verbose", "False"]);
    const segs = (JSON.parse(readFileSync(join(tmp, "audio.json"), "utf8")) as { segments: Segment[] }).segments;
    if (!segs.length) throw new Error("no speech found");

    step(`picking with ${model}`);
    const picks = parsePicks(await pick(segs, ask, model), segs, duration);
    if (!picks.length) throw new Error("the model returned no usable clips; try another model or request");

    mkdirSync(out, { recursive: true });
    for (const [i, p] of picks.entries()) {
      step(`cutting ${i + 1}/${picks.length}: ${p.start.toFixed(1)}-${p.end.toFixed(1)} s "${p.title}"`);
      const frames = JSON.parse(run("uv", ["run", "-q", "--no-project", "--with", "opencv-python-headless<5", "python", "-I",
        resolve(import.meta.dirname, "clip-frame.py"), src, String(p.start), String(p.end)])) as Frame[];
      writeFileSync(join(tmp, `c${i}.srt`), captionsSrt(segs, p));
      run("ffmpeg", cutArgs(src, p, frames, `c${i}.srt`, join(out, `clip-${i + 1}.mp4`)), tmp);
    }
    console.log(JSON.stringify(picks.map((p, i) => ({ file: join(out, `clip-${i + 1}.mp4`), ...p })), null, 2));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(`error: ${e instanceof Error ? e.message : e}`); process.exit(1); });
