// The narwhal mark sampled at 46x19 and set into a 52x27 dot field: # body, + edge, . soft edge, t tusk (a t left of
// column 30 is the eye, left empty). Each inked dot resolves out of the field after a pseudo-random delay (landing.css).
const BMP = [
  "                                           .t.",
  "                                          +t+ ",
  "                     .++++++..          .tt.  ",
  "                .+##############+      +tt.   ",
  "              +###################.  .tt+     ",
  "            +######################++#t.      ",
  "          .###########################.       ",
  " ++.     .###########################         ",
  " +##+  .+###########ttt##############         ",
  "  ##################t#t##############         ",
  "  ##################tt###############         ",
  "  ###################t##############+         ",
  " +##+  .+##########################+          ",
  " ++.     .+#######################+           ",
  "            +####################.            ",
  "               ++#############+.              ",
  "                   +##.....                   ",
  "                   ##+                        ",
  "                  .+.                         ",
];
const COLS = 52, ROWS = 27, OX = 3, OY = 4;
const KIND: Record<string, string> = { "#": "k-full", "+": "k-mid", ".": "k-low", t: "k-tusk" };

const DOTS: string[] = [];
for (let y = 0; y < ROWS; y++) {
  for (let x = 0; x < COLS; x++) {
    const ch = BMP[y - OY]?.charAt(x - OX) || " ";
    const k = ch === "t" && x - OX < 30 ? "k-eye" : KIND[ch] ?? "";
    const wave = Math.abs(Math.floor(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453)) % 10;
    DOTS.push(k && k !== "k-eye" ? `dot ${k} w${wave}` : `dot ${k}`.trim());
  }
}

/** The hero's small dot narwhal (decorative). */
export function DotNarwhal() {
  return <div className="dot-narwhal" aria-hidden>{DOTS.map((c, i) => <span key={i} className={c} />)}</div>;
}
