import "./globals.css";
import { headers } from "next/headers";
import { DM_Sans, Geist, Geist_Mono, Instrument_Serif, JetBrains_Mono, Source_Serif_4 } from "next/font/google";

// next/font downloads these at build time and serves them from this origin, so the CSP keeps font-src 'self'.
// The landing page (and /models) use Geist and Geist Mono only; the app shell still uses the three faces below it.
const geist = Geist({ subsets: ["latin", "latin-ext"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin", "latin-ext"], variable: "--font-geist-mono", display: "swap" });
const sans = DM_Sans({ subsets: ["latin", "latin-ext"], variable: "--font-sans", display: "swap" });
const serif = Instrument_Serif({ subsets: ["latin", "latin-ext"], weight: "400", style: "italic", variable: "--font-serif", display: "swap" });
// The design's body face (Broadsheet): the app and the legal pages.
const body = Source_Serif_4({ subsets: ["latin", "latin-ext"], style: ["normal", "italic"], variable: "--font-body", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin", "latin-ext"], variable: "--font-mono", display: "swap" });

// metadataBase makes every page's og:image URL absolute, so WhatsApp and Facebook previews work site-wide.
export const metadata = { metadataBase: new URL("https://hiddensee.app"), title: "Hiddensee · Ask AI privately", description: "Open models in hardware enclaves. Our server is in Germany. No email needed.", openGraph: { siteName: "Hiddensee", type: "website" } };
/** Reading the request headers renders every page per request, so Next.js can stamp the CSP nonce from middleware.ts on its scripts. */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await headers();
  const fonts = [geist, geistMono, sans, serif, mono, body].map((f) => f.variable).join(" ");
  return (<html lang="en" className={fonts}><body>{children}</body></html>);
}
