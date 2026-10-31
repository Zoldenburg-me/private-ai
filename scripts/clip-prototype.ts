/**
 * Prototype of Clips (docs/clip-spec.md): a video file or YouTube link plus a plain-language request in, vertical clips out.
 *   npx vite-node scripts/clip-prototype.ts -- (--file in.mp4 | --url https://youtu.be/…) --ask "3 punchy clips" --model <id> [--out clips]
 * Needs ffmpeg, yt-dlp (for --url) and uv (runs faster-whisper via whisper-ctranslate2, and OpenCV for scripts/clip-frame.py). The picking model is any
 * OpenAI-compatible endpoint: CLIP_BASE_URL (default http://127.0.0.1:3000/api/v1, Hiddensee) and CLIP_API_KEY
 * (default: a fresh anonymous Hiddensee session). Temp files are deleted at the end, also on Ctrl-C or SIGTERM (not on SIGKILL);
 * only the clips stay in --out. Progress output carries no titles, times or tool output, as the server version's logs must not;
 * CLIP_DEBUG=1 shows the tools' own stderr.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LIMITS, PICK_SYSTEM, captionsSrt, cutArgs, parseFrames, parsePicks, transcriptForModel, youtubeUrl, type Segment } from "../lib/clip";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`), v = i > 0 ? process.argv[i + 1] : undefined;
  if (v?.startsWith("--")) throw new Error(`--${name} needs a value`);
  return v;
};
const BASE = process.env.CLIP_BASE_URL ?? "http://127.0.0.1:3000/api/v1";
const WHISPER_MODEL = process.env.CLIP_WHISPER_MODEL ?? "small";
// Media is untrusted: ffmpeg and OpenCV may read local files only, never URLs inside a playlist (HLS SSRF).
const LOCAL_ONLY = ["-protocol_whitelist", "file,pipe"];
let current: ChildProcess | undefined;
/** Kills a tool with everything it started (uv -> python, yt-dlp -> ffmpeg): each runs in its own process group. */
const killTree = (p?: ChildProcess) => { try { if (p?.pid) process.kill(-p.pid, "SIGKILL"); } catch { /* already gone */ } };
/** Runs a tool with a time limit, without blocking, so a stop signal is handled at once. Its output is never printed:
 *  it can hold paths, URLs and transcript text. */
const run = (cmd: string, args: string[], cwd?: string, timeoutS = 3600) => new Promise<string>((done, fail) => {
  const p = current = spawn(cmd, args, { cwd, detached: true, stdio: ["ignore", "pipe", process.env.CLIP_DEBUG ? "inherit" : "ignore"],
    env: { ...process.env, OPENCV_FFMPEG_CAPTURE_OPTIONS: "protocol_whitelist;file" } });
  const chunks: Buffer[] = [];
  p.stdout!.on("data", (c: Buffer) => chunks.push(c));
  const timer = setTimeout(() => killTree(p), timeoutS * 1000);
  p.on("error", () => { clearTimeout(timer); fail(new Error(`${cmd} failed (could not start)`)); });
  p.on("close", (code, signal) => {
    clearTimeout(timer); current = undefined;
    if (code === 0) done(Buffer.concat(chunks).toString()); else fail(new Error(`${cmd} failed (${signal ?? `exit ${code}`})`));
  });
});
/** JSON.parse with a fixed error: Node's SyntaxError quotes the input, which can be transcript or a provider's page. */
const parseJson = <T>(text: string, what: string): T => { try { return JSON.parse(text) as T; } catch { throw new Error(`unreadable ${what}`); } };
const step = (s: string) => console.error(`· ${s}`);

async function apiKey(): Promise<string> {
  if (process.env.CLIP_API_KEY) return process.env.CLIP_API_KEY;
  const res = await fetch(`${new URL(BASE).origin}/api/session`, { signal: AbortSignal.timeout(10_000) });
  const s = res.ok ? parseJson<{ apiToken?: string }>(await res.text(), "session response") : {};
  if (!s.apiToken) throw new Error(`no apiToken from /api/session (HTTP ${res.status}); set CLIP_API_KEY`);
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
  if (!res.ok) { res.body?.cancel().catch(() => {}); throw new Error(`picking model: HTTP ${res.status}`); }
  return parseJson<{ choices?: { message?: { content?: string } }[] }>(await res.text(), "model response").choices?.[0]?.message?.content ?? "";
}

async function main() {
  const ask = arg("ask"), model = arg("model") ?? process.env.CLIP_MODEL, file = arg("file"), url = arg("url");
  if (!ask || !model || !file === !url) throw new Error("usage: --file in.mp4 | --url <youtube link> (one of them), --ask \"…\", --model <id>");
  if (file && !existsSync(file)) throw new Error("--file not found");
  const u = new URL(BASE);
  if (u.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) throw new Error("CLIP_BASE_URL must be https unless it is local");
  const out = resolve(arg("out") ?? "clips");
  const tmp = mkdtempSync(join(tmpdir(), "clip-"));
  // finally does not run when the process is stopped by a signal: stop the running tool, then delete the temp files.
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { killTree(current); rmSync(tmp, { recursive: true, force: true }); process.exit(130); });
  try {
    let src = file ? resolve(file) : "";
    if (url) {
      const yt = youtubeUrl(url);
      if (!yt) throw new Error("only YouTube links are accepted");
      step("downloading");
      await run("yt-dlp", ["--no-playlist", "--quiet", "--match-filter", `duration<=${LIMITS.maxSourceS}`, "-f", "bv*[height<=1080]+ba/b[height<=1080]",
        "--merge-output-format", "mp4", "-o", join(tmp, "src.%(ext)s"), yt]);
      const got = readdirSync(tmp).find((f) => f.startsWith("src."));
      if (!got) throw new Error(`video not downloaded (longer than ${LIMITS.maxSourceS / 3600} h, private, or blocked)`);
      src = join(tmp, got);
    }
    const duration = Number(await run("ffprobe", ["-v", "error", ...LOCAL_ONLY, "-show_entries", "format=duration", "-of", "csv=p=0", src], undefined, 60));
    if (!(duration > 0) || duration > LIMITS.maxSourceS) throw new Error(`source must be 0-${LIMITS.maxSourceS} s, is ${duration}`);

    step(`transcribing ${Math.round(duration)} s with whisper ${WHISPER_MODEL}`);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", ...LOCAL_ONLY, "-i", src, "-vn", "-ac", "1", "-ar", "16000", join(tmp, "audio.wav")]);
    await run("uvx", ["whisper-ctranslate2", join(tmp, "audio.wav"), "--model", WHISPER_MODEL, "--word_timestamps", "True",
      "--output_format", "json", "--output_dir", tmp, "--verbose", "False"], undefined, 3 * 3600); // CPU Whisper on a 2 h source
    const segs = parseJson<{ segments?: Segment[] }>(readFileSync(join(tmp, "audio.json"), "utf8"), "transcript").segments ?? [];
    if (!segs.length) throw new Error("no speech found");

    step(`picking with ${model}`);
    const picks = parsePicks(await pick(segs, ask, model), segs, duration);
    if (!picks.length) throw new Error("the model returned no usable clips; try another model or request");

    mkdirSync(out, { recursive: true });
    for (const [i, p] of picks.entries()) {
      step(`cutting ${i + 1}/${picks.length} (${Math.round(p.end - p.start)} s)`);
      const frames = parseFrames(await run("uv", ["run", "-q", "--no-project", "--with", "opencv-python-headless<5", "python", "-I",
        resolve(import.meta.dirname, "clip-frame.py"), src, String(p.start), String(p.end)], undefined, 600));
      writeFileSync(join(tmp, `c${i}.srt`), captionsSrt(segs, p));
      await run("ffmpeg", cutArgs(src, p, frames, `c${i}.srt`, join(out, `clip-${i + 1}.mp4`)), tmp);
    }
    console.log(JSON.stringify(picks.map((p, i) => ({ file: join(out, `clip-${i + 1}.mp4`), ...p })), null, 2));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(`error: ${e instanceof Error ? e.message : e}`); process.exit(1); });
