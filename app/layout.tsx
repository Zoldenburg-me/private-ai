import "./globals.css";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";

// next/font downloads these at build time and serves them from this origin, so the CSP keeps font-src 'self'.
const geist = Geist({ subsets: ["latin", "latin-ext"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin", "latin-ext"], variable: "--font-geist-mono", display: "swap" });

// metadataBase makes every page's og:image URL absolute, so WhatsApp and Facebook previews work site-wide.
export const metadata = { metadataBase: new URL("https://hiddensee.app"), title: "Hiddensee · Ask AI privately", description: "Open models in hardware enclaves. Our server is in Germany. No email needed.", openGraph: { siteName: "Hiddensee", type: "website" } };
/** Reading the request headers renders every page per request, so Next.js can stamp the CSP nonce from middleware.ts on its scripts. */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await headers();
  return (<html lang="en" className={`${geist.variable} ${geistMono.variable}`}><body>{children}</body></html>);
}
