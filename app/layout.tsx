import "./globals.css";

export const metadata = { title: "Private AI (working title)", description: "Private AI chat on attested TEE inference" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body>
      {children}
      <footer className="site-footer">
        <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a> · <a href="/agb">AGB</a> · <a href="/privacy/metadata">Stored data</a>
      </footer>
    </body></html>);
}
