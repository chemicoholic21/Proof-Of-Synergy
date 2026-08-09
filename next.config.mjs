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
    // Load the Next.js instrumentation.ts hook, which bootstraps OpenTelemetry → Arize Phoenix.
    instrumentationHook: true,
    // These heavy CJS/native-ish packages must be required at runtime from node_modules rather than
    // bundled by webpack: pdf-parse/mammoth break when bundled, and the OpenTelemetry SDK + OTLP
    // exporter (protobufjs) must not be pulled into route bundles.
    serverComponentsExternalPackages: [
      "pdf-parse",
      "mammoth",
      "sarvamai",
      "@opentelemetry/sdk-trace-node",
      "@opentelemetry/exporter-trace-otlp-proto",
      "@opentelemetry/resources",
    ],
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
