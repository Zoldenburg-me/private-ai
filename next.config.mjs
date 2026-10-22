/** @type {import('next').NextConfig} */
export default {
  poweredByHeader: false,
  // Self-contained server bundle for the Docker image (Dockerfile copies .next/standalone).
  output: "standalone",
  // The Privatemode SDK reads privatemode.wasm beside its own JS at runtime, a path no bundler or tracer can see:
  // keep the package unbundled and copy the file into the standalone output.
  serverExternalPackages: ["privatemode-ai"],
  outputFileTracingIncludes: { "/**": ["./node_modules/privatemode-ai/dist/privatemode.wasm"] },
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
