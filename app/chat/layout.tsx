export const metadata = { title: "Chat · Private AI" };
/** viewport-fit=cover makes env(safe-area-inset-*) work, so the composer clears the iPhone home bar. */
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (<>
    {children}
    <footer className="site-footer">
      <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a> · <a href="/agb">AGB</a> · <a href="/privacy/metadata">Stored data</a>
    </footer>
  </>);
}
