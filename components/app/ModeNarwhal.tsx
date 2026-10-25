import Image from "next/image";
import type { Level } from "@/lib/client/levels";
import type { Note } from "@/lib/client/tone";

/**
 * The pixel narwhal per privacy level (design canvas, PixelBody board): green = attested enclave (tee-attested),
 * ink = zero retention by contract (zdr-contract), classic = anonymized gateway (anon-gateway).
 */
export const MODE_LOOK: Record<Level, { src: string; alt: string; caption: string; tone: string; sound: readonly Note[] }> = {
  max: { src: "/brand/narwhal-tee.svg", alt: "Green narwhal: private enclave", caption: "Private enclave, checked before you chat", tone: "#0f7a4b",
    sound: [[196, 0.08, "triangle", 0.08], [784, 0.12], [1175, 0.26]] },
  medium: { src: "/brand/narwhal-zdr.svg", alt: "Ink narwhal: zero retention", caption: "Zero retention by contract, no hardware proof", tone: "#3b3e44",
    sound: [[660, 0.1], [880, 0.22]] },
  anon: { src: "/brand/narwhal-anon.svg", alt: "Classic narwhal: anonymized", caption: "Anonymized gateway, the provider sees the text", tone: "#232323",
    sound: [[1046, 0.1, "sine", 0.04], [784, 0.14, "sine", 0.03], [523, 0.24, "sine", 0.02]] },
};

/** The narwhal tile for a level; decorative unless `label` is set. */
export function ModeNarwhal({ level, size, label = false, className = "" }: { level: Level; size: number; label?: boolean; className?: string }) {
  const look = MODE_LOOK[level];
  return <Image src={look.src} alt={label ? look.alt : ""} aria-hidden={label ? undefined : true} width={size} height={size} unoptimized
    className={`mode-narwhal mode-${level} ${className}`.trim()} data-testid={label ? "mode-narwhal" : undefined} />;
}
