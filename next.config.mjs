/** @type {import('next').NextConfig} */

// Security headers applied to every response. CSP is intentionally pragmatic: it allows the
// inline styles/scripts Next.js needs in this app while restricting external origins to the
// APIs this app actually talks to.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // pdf-parse (pdfjs) and mammoth are heavy native-ish CJS packages that must be required at
  // runtime from node_modules rather than bundled by webpack — bundling breaks their worker /
  // dynamic imports and would pull test fixtures into the build.
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse", "mammoth"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
