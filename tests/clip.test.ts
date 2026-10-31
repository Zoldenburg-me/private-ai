import { describe, it, expect } from "vitest";
import { LIMITS, captionsSrt, frameFilter, parsePicks, youtubeUrl, type Segment } from "../lib/clip";

const segs: Segment[] = Array.from({ length: 20 }, (_, i) => ({ start: i * 10, end: i * 10 + 9.5, text: `sentence ${i}` }));
const picks = (clips: unknown) => parsePicks(JSON.stringify({ clips }), segs, 200);

describe("youtubeUrl", () => {
  it("normalises YouTube links and rejects everything else", () => {
    const want = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
    for (const u of ["https://youtu.be/jNQXAC9IVRw", "https://m.youtube.com/watch?v=jNQXAC9IVRw&t=3", "https://www.youtube.com/shorts/jNQXAC9IVRw"]) expect(youtubeUrl(u)).toBe(want);
    for (const u of ["http://youtu.be/jNQXAC9IVRw", "https://evil.com/watch?v=jNQXAC9IVRw", "https://youtube.com.evil.com/watch?v=jNQXAC9IVRw",
      "https://www.youtube.com/watch?v=../../etc", "file:///etc/passwd", "not a url"]) expect(youtubeUrl(u)).toBeNull();
  });
});

describe("parsePicks", () => {
  it("snaps edges to sentences, clamps and sorts", () => {
    expect(picks([{ start: 53, end: 74, title: "b" }, { start: 12, end: 27, title: "a" }])).toEqual([
      { start: 10, end: 29.5, title: "a" }, { start: 50, end: 79.5, title: "b" }]);
  });
  it("drops overlaps, too-short, non-numeric and inverted clips, and caps length and count", () => {
    expect(picks([{ start: 10, end: 30 }, { start: 20, end: 40 }, { start: "1", end: 9 }, { start: 150, end: 120 }, { start: NaN, end: 5 }]))
      .toEqual([{ start: 10, end: 29.5, title: "" }]);
    expect(parsePicks(JSON.stringify({ clips: [{ start: 0, end: 2 }] }), [{ start: 0, end: 2, text: "hi" }], 60)).toEqual([]);
    expect(picks([{ start: 0, end: 190 }])[0].end).toBe(LIMITS.maxS);
    expect(picks(Array.from({ length: 9 }, (_, i) => ({ start: i * 20, end: i * 20 + 15 })))).toHaveLength(LIMITS.maxClips);
  });
  it("accepts fenced JSON and returns nothing for garbage", () => {
    expect(parsePicks('```json\n{"clips":[{"start":0,"end":9}]}\n```', segs, 200)).toHaveLength(1);
    for (const raw of ["sure! here are clips", "{}", '{"clips":"x"}']) expect(parsePicks(raw, segs, 200)).toEqual([]);
  });
});

describe("captionsSrt", () => {
  it("groups words in threes with times relative to the clip", () => {
    const words = ["one", "two", "three", "four"].map((word, i) => ({ start: 10 + i, end: 10.9 + i, word: ` ${word}` }));
    expect(captionsSrt([{ start: 10, end: 14, text: "", words }], { start: 10, end: 14, title: "" })).toBe(
      "1\n00:00:00,000 --> 00:00:02,900\none two three\n\n2\n00:00:03,000 --> 00:00:03,900\nfour\n");
  });
});

describe("frameFilter", () => {
  const f = frameFilter([
    { t: 0, layout: "one", boxes: [[0.2, 0, 0.3, 1]] },
    { t: 5, layout: "split", boxes: [[0.06, 0.16, 0.36, 0.57], [0.63, 0.15, 1.4, 0.58]] },
    { t: 9, layout: "fit", boxes: [] },
    { t: 12, layout: "one", boxes: [] },
  ], "c0.srt");
  it("lays each framed run over the whole-frame layout for its own time", () => {
    expect(f).toContain("[0:v]split=3[base][s0][s1]");
    expect(f).toContain("[s0]trim=start=0:end=5,crop=iw*0.3000:ih*1.0000:iw*0.2000:ih*0.0000,scale=1080:1920,setsar=1[v0]");
    expect(f).toContain("[o0][v0]overlay=0:0:eof_action=pass:enable='gte(t,0)*lt(t,5)'[o1]");
    expect(f).toContain("[t1][u1]vstack[v1]");
    expect(f).toContain("crop=iw*1.0000:ih*0.5800:iw*0.6300:ih*0.1500"); // clamped to the frame
    expect(f).toMatch(/\[o2\]subtitles=c0\.srt:.*\[v\]$/);
  });
  it("skips runs without boxes and uses only the whole-frame layout when nothing is framed", () => {
    expect(f).not.toContain("[s2]");
    expect(frameFilter([{ t: 0, layout: "fit", boxes: [] }], "c0.srt")).toContain("[0:v]split=1[base];[base]split[b][c]");
  });
});
