import "./globals.css";
import { headers } from "next/headers";
import { DM_Sans, Instrument_Serif, JetBrains_Mono } from "next/font/google";

// next/font downloads these at build time and serves them from this origin, so the CSP keeps font-src 'self'.
const sans = DM_Sans({ subsets: ["latin", "latin-ext"], variable: "--font-sans", display: "swap" });
const serif = Instrument_Serif({ subsets: ["latin", "latin-ext"], weight: "400", style: "italic", variable: "--font-serif", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin", "latin-ext"], variable: "--font-mono", display: "swap" });

export const metadata = { title: "Private AI (working title)", description: "Private AI chat on attested TEE inference" };
/** Reading the request headers renders every page per request, so Next.js can stamp the CSP nonce from middleware.ts on its scripts. */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await headers();
  return (<html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable}`}><body>{children}</body></html>);
}
