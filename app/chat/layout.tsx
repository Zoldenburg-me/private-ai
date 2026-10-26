export const metadata = { title: "Chat · Hiddensee" };
/** viewport-fit=cover makes env(safe-area-inset-*) work, so the composer clears the iPhone home bar. */
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (<>
    {children}
    <footer className="site-footer">
      <a href="/impressum">Legal notice</a> · <a href="/datenschutz">Privacy</a> · <a href="/agb">Terms</a> · <a href="/privacy/metadata">Stored data</a>
    </footer>
  </>);
}
