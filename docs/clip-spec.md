# Clips: from a long video to short clips, in plain language

The user gives a video (an upload, or later a YouTube link) and says what they want: "3 punchy clips under 60 s about pricing", "the moment he says he hasn't written code in two years". Hiddensee returns vertical clips with burned-in captions. Prototype: `lib/clip.ts` and `scripts/clip-prototype.ts`.

## What we promise

The video may be public. What the user asks for, and which clips they make, is not. So:
- The only model that reads anything is the chat model that picks the moments. It gets the transcript and the request, as text, and runs on a TEE provider like other private chats.
- Transcription (Whisper) and cutting (ffmpeg) run on our server. Nothing leaves it.
- Nothing is stored: the source, audio, transcript and clips live in a temp directory for one job and are deleted when it ends, whether it succeeds or fails. The clips go to the browser, like `generate_video`.
- Nothing about the job goes to the logs except duration, clip count and status.

## Pipeline

1. **Source.** Upload (first) or a YouTube link (second, see Risks). Links pass `youtubeUrl()`: YouTube hosts only, normalised to `https://www.youtube.com/watch?v=<id>`, so `yt-dlp` never fetches an arbitrary URL. Max source length 2 h, max 1080p.
2. **Audio.** ffmpeg to 16 kHz mono WAV.
3. **Transcript.** Whisper (faster-whisper) with word timestamps. Model `small` on CPU is enough to find moments; captions improve with `medium`.
4. **Pick.** One chat call: `PICK_SYSTEM` + timestamped transcript + the request. The model answers `{"clips":[{"start","end","title"}]}`. `parsePicks()` treats that answer as untrusted: it checks the numbers, clamps them to the video, snaps the edges to sentence boundaries, enforces 5–90 s per clip, drops overlaps and keeps at most 5. If nothing survives, the job fails with a fixed text.
5. **Cut.** Per clip: ffmpeg cuts, centre-crops to 9:16, scales to 1080x1920 and burns captions of up to 3 words each (`captionsSrt()`).
6. **Deliver.** Stream each clip as soon as it is cut. Delete the temp directory.

## Product shape

- Its own route (`/api/clip`), not an agent tool: an hour of podcast takes several minutes to transcribe, which is beyond the agent's 300 s. Progress goes over SSE (downloading, transcribing, picking, cutting 2/3).
- One job per user at a time, and a server-wide queue sized to the box's cores. Paid tiers only.
- Price per source minute (transcription is the cost), plus the chat call.
- A follow-up like "make the second one shorter" reuses the transcript only if the browser sends it back; the server keeps nothing between jobs.

## Risks

- **YouTube terms** forbid downloading outside their player, and YouTube blocks server IPs that use `yt-dlp` heavily. Prod runs on the home connection, so a block hits all users and the household. Ship uploads first; add links only after a legal check, and consider a separate egress IP.
- **Copyright.** Reposting clips of other people's videos is the user's act, but we get the takedown notices. Terms must say the user needs the rights; uploads of one's own footage avoid the question.
- **Compute.** Whisper on CPU runs at about real time divided by 4–10 depending on model and cores. Measure on the home server before setting limits.
- **Model quality.** Small models return bad timestamps or invalid JSON. `parsePicks()` catches both; add cases to the agent eval to choose which models may pick.

## Not in the prototype

Speaker-aware framing (crop follows the speaker), styled captions (HyperFrames `embedded-captions`), uploads through the web app, the route, the queue and billing.
