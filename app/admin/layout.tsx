/** Operators only. Not linked from the public site; noindex here and via X-Robots-Tag (middleware.ts). */
export const metadata = { title: "Admin · Private AI", robots: { index: false, follow: false } };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
