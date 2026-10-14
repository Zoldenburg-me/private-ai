/** @type {import('next').NextConfig} */
export default {
  poweredByHeader: false,
  // Self-contained server bundle for the Docker image (Dockerfile copies .next/standalone).
  output: "standalone",
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
      ],
    }];
  },
};
