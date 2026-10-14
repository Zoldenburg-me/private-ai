import { headers } from "next/headers";

export const metadata = { title: "Private AI (working title)", description: "Private AI chat on attested TEE inference" };
/** Reading the request headers renders every page per request, so Next.js can stamp the CSP nonce from middleware.ts on its scripts. */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await headers();
  return (<html lang="en"><body style={{ fontFamily: "system-ui", margin: 0, background: "#0f1115", color: "#e6e6e6" }}>
      {children}
      <footer style={{ position: "fixed", right: 8, bottom: 4, fontSize: 11, opacity: 0.7 }}>
        <a href="/impressum" style={{ color: "#9ca3af" }}>Impressum</a> · <a href="/datenschutz" style={{ color: "#9ca3af" }}>Datenschutz</a> · <a href="/agb" style={{ color: "#9ca3af" }}>AGB</a> · <a href="/privacy/metadata" style={{ color: "#9ca3af" }}>Stored data</a>
      </footer>
    </body></html>);
}
