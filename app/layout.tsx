import "./globals.css";
import { headers } from "next/headers";

export const metadata = { title: "Private AI (working title)", description: "Private AI chat on attested TEE inference" };
/** Reading the request headers renders every page per request, so Next.js can stamp the CSP nonce from middleware.ts on its scripts. */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await headers();
  return (<html lang="en"><body>
      {children}
      <footer className="site-footer">
        <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a> · <a href="/agb">AGB</a> · <a href="/privacy/metadata">Stored data</a>
      </footer>
    </body></html>);
}
