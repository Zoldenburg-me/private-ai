import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

// The link preview WhatsApp and Facebook show (1200×630 is Facebook's recommended size).
export const alt = "Hiddensee: Ask AI privately. Out of sight.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage() {
  const svg = await readFile(join(process.cwd(), "public/brand/narwhal.svg"));
  const narwhal = `data:image/svg+xml;base64,${svg.toString("base64")}`;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#000", color: "#f4f0f2" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders plain <img> only */}
        <img src={narwhal} width={244} height={132} alt="" />
        <div style={{ marginTop: 40, fontSize: 104, fontWeight: 700, letterSpacing: "-0.03em" }}>Hiddensee</div>
        <div style={{ marginTop: 12, fontSize: 44, color: "#b9aab2" }}>Ask AI privately. Out of sight.</div>
      </div>
    ),
    size,
  );
}
