export const metadata = { title: "Chat · Private AI" };

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (<>
    {children}
    <footer className="site-footer">
      <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a> · <a href="/agb">AGB</a> · <a href="/privacy/metadata">Stored data</a>
    </footer>
  </>);
}
