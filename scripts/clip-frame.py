"""Where to frame a vertical clip (docs/clip-spec.md), per moment:
  one face, or two with one clearly talking -> "one": crop on that face, zoomed so the face reads on a phone
  two people, unclear who talks            -> "split": both crops stacked
  no face                                  -> "fit": the whole frame over a blurred fill
  uv run --no-project --with "opencv-python-headless<5" python -I scripts/clip-frame.py <video> <start s> <end s>
Prints JSON [{"t": s from clip start, "layout": "one"|"split"|"fit", "boxes": [[x, y, w, h], ...] as 0-1 of the frame}], one entry per change.
Who talks: mouth-area motion minus upper-face motion between two frames ~0.1 s apart, so nodding and head turns don't count.
shortcut: OpenCV Haar cascades (bundled, no model download) miss some angles; swap for YuNet or MediaPipe if framing misfires.
"""
import json, statistics, sys

import cv2
import numpy as np

SAMPLE_FPS = 5
MIN_FACE = 0.12     # of frame height: ignores small faces on posters and screens
MIN_SKIN = 0.4      # share of skin-coloured pixels in the box centre: drops plants, windows and other look-alikes
SECOND_FACE = 0.3   # a second face at least this big (area, relative to the largest) means two people in shot
TALK_MIN = 0.15     # mean mouth motion over the window (0-255 pixel change, faces aligned) that counts as talking
TALK_RATIO = 2.0    # the talker must move this much more than the other person over the window
TALK_WIN = 7        # samples (~1.4 s) of mouth motion summed per person: speech pauses between syllables
SMOOTH = 7          # samples in the majority window, so one noisy sample doesn't flip the framing
MIN_SEG = 1.2       # s: shorter runs are merged into the one before, so the layout doesn't flicker
ZOOM_ONE, ZOOM_SPLIT = 4.0, 3.0  # crop height in face heights

src, start, end = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
cascades = [cv2.CascadeClassifier(cv2.data.haarcascades + f) for f in ("haarcascade_frontalface_default.xml", "haarcascade_profileface.xml")]

def faces(color):
    """Face boxes (x, y, w, h) in pixels, largest first, skin-coloured only, duplicates from several cascades merged."""
    gray = cv2.cvtColor(color, cv2.COLOR_BGR2GRAY)
    skin = cv2.inRange(cv2.cvtColor(color, cv2.COLOR_BGR2YCrCb), (0, 135, 85), (255, 180, 135))
    h, w = gray.shape
    found = []
    for flip in (False, True):
        img = cv2.flip(gray, 1) if flip else gray
        for c in cascades:
            for (x, y, fw, fh) in c.detectMultiScale(img, 1.1, 6, minSize=(int(h * MIN_FACE),) * 2):
                fx = (w - x - fw) if flip else x
                if (skin[y + fh // 5: y + fh * 4 // 5, fx + fw // 5: fx + fw * 4 // 5] > 0).mean() >= MIN_SKIN:
                    found.append((fx, y, fw, fh))
    found.sort(key=lambda f: -f[2] * f[3])
    kept = []
    for f in found:
        if all(abs((f[0] + f[2] / 2) - (k[0] + k[2] / 2)) > f[2] for k in kept):
            kept.append(f)
    return kept

def talk(a, b, f):
    """Mouth motion minus eye-area motion for face box f between grey frames a and b, after lining the face up,
    so head and body sway don't count and only the mouth region inside the face is measured (no scarf or collar)."""
    x, y, w, h = f
    pa, pb = a[y:y + h, x:x + w].astype(np.float32), b[y:y + h, x:x + w].astype(np.float32)
    if pa.shape != pb.shape or min(pa.shape) < 16:
        return 0.0
    (dx, dy), _ = cv2.phaseCorrelate(pa, pb)
    pb = cv2.warpAffine(pb, np.float32([[1, 0, -dx], [0, 1, -dy]]), (w, h), borderMode=cv2.BORDER_REPLICATE)
    diff = cv2.absdiff(pa, pb)
    mouth = diff[int(h * 0.65): int(h * 0.92), int(w * 0.25): int(w * 0.75)]
    eyes = diff[int(h * 0.25): int(h * 0.5), int(w * 0.2): int(w * 0.8)]
    return float(mouth.mean() - eyes.mean())

def box(f, W, H, zoom, aspect):
    """A crop of output aspect `aspect` (w/h) around face f, as 0-1 fractions; the face sits in the upper part."""
    x, y, w, h = f
    ch = min(H, zoom * h)
    cw = ch * aspect
    if cw > W:
        cw, ch = W, W / aspect
    cx, cy = x + w / 2, y + h / 2
    bx = min(max(cx - cw / 2, 0), W - cw)
    by = min(max(cy - 0.4 * ch, 0), H - ch)
    return [round(bx / W, 4), round(by / H, 4), round(cw / W, 4), round(ch / H, 4)]

cap = cv2.VideoCapture(src)
cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
fps = cap.get(cv2.CAP_PROP_FPS) or 25
step = max(3, round(fps / SAMPLE_FPS))
gap = max(1, round(fps * 0.1))  # frames between the two compared for mouth motion
samples, i, pending = [], 0, None
while True:
    ok, frame = cap.read()
    t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
    if not ok or t > end:
        break
    if i % step == 0 or (pending and i % step == gap):
        color = cv2.resize(frame, (640, round(640 * frame.shape[0] / frame.shape[1])))
        small = cv2.cvtColor(color, cv2.COLOR_BGR2GRAY)
        if i % step == 0:
            pending = (max(0.0, t - start), small, faces(color))
        else:
            ts, first, fs = pending
            pending = None
            H, W = small.shape
            big = [f for f in fs if f[2] * f[3] >= SECOND_FACE * fs[0][2] * fs[0][3]][:2] if fs else []
            if not big:
                samples.append((ts, ("fit",), []))
            elif len(big) == 1:
                samples.append((ts, ("one", "solo"), [box(big[0], W, H, ZOOM_ONE, 9 / 16)]))
            else:
                big.sort(key=lambda f: f[0])  # left person, right person
                # Negative values are head motion, not speech.
                m = [max(0.0, talk(first, small, f)) for f in big]
                samples.append((ts, ("pair", m), {"one": [[box(f, W, H, ZOOM_ONE, 9 / 16)] for f in big],
                                                   "split": [box(f, W, H, ZOOM_SPLIT, 9 / 8) for f in big]}))
    i += 1

# Two people: whoever moved their mouth clearly more over the window is the speaker; otherwise show both.
for j, (ts, key, b) in enumerate(samples):
    if key[0] != "pair":
        continue
    near = [k[1] for _, k, _ in samples[max(0, j - TALK_WIN // 2): j + TALK_WIN // 2 + 1] if k[0] == "pair"]
    m = [sum(v[p] for v in near) / len(near) for p in (0, 1)]
    hi = int(m[1] > m[0])
    if m[hi] > TALK_MIN and m[hi] > TALK_RATIO * max(m[1 - hi], 0.05):
        samples[j] = (ts, ("one", "LR"[hi]), b["one"][hi])
    else:
        samples[j] = (ts, ("split",), b["split"])

# Majority vote over a sliding window, then runs of equal layouts with their median boxes.
runs = []
for j, (ts, key, _) in enumerate(samples):
    win = [k for _, k, _ in samples[max(0, j - SMOOTH // 2): j + SMOOTH // 2 + 1]]
    key = max(set(win), key=win.count)
    if runs and runs[-1]["key"] == key:
        runs[-1]["idx"].append(j)
    else:
        runs.append({"t": ts, "key": key, "idx": [j]})
merged = []
for r in runs:
    if merged and (r["key"] == merged[-1]["key"] or len(r["idx"]) / SAMPLE_FPS < MIN_SEG):
        merged[-1]["idx"] += r["idx"]
    else:
        merged.append(r)

out = []
for r in merged:
    layout = r["key"][0]
    boxes = [samples[j][2] for j in r["idx"] if samples[j][1] == r["key"]]
    med = [[round(statistics.median(b[n][c] for b in boxes), 4) for c in range(4)] for n in range(len(boxes[0]))] if boxes and layout != "fit" else []
    out.append({"t": round(r["t"], 2), "layout": layout if med or layout == "fit" else "fit", "boxes": med})
if out:
    out[0]["t"] = 0
print(json.dumps(out or [{"t": 0, "layout": "fit", "boxes": []}]))
