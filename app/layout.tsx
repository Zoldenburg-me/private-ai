export const metadata = { title: "Private AI (working title)", description: "Private AI chat on attested TEE inference" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body style={{ fontFamily: "system-ui", margin: 0, background: "#0f1115", color: "#e6e6e6" }}>{children}</body></html>);
}
