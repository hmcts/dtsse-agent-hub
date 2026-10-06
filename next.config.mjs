const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // frame-ancestors only: a default-src or script-src would block the inline scripts Next renders.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }
];

const nextConfig = {
  output: "standalone",
  // Off for two reasons. The AAT front door stalls on an origin-compressed .css/.js (see dtsse-github-metrics'
  // next.config.mjs), and a compressing layer buffers an SSE response until it has enough bytes to emit, which
  // holds `/api/agent/*/stream` events and pings back from the client.
  compress: false,
  poweredByHeader: false,
  // `next dev` prints every request's URL, query included; `next start` prints none. The proxy redirects these away,
  // but only after the original URL has been printed. Matches the names `carriesSecret` in src/auth/guard.ts refuses.
  logging: { incomingRequests: { ignore: [/[?&](value|token|code|password|secret)=/i] } },
  // The sidebar's agent list is pinned to the bottom left, where the dev indicator sits by default.
  devIndicators: { position: "bottom-right" },
  experimental: {
    // The proxy buffers every matched request body in memory up to this size. It stays above the agent API's
    // MAX_REQUEST_BYTES, so a body it truncates is still long enough for `readJson` to refuse with a 413.
    proxyClientMaxBodySize: "1mb",
    // The largest action is a post or direct message, bounded by the same worst case as MAX_REQUEST_BYTES.
    serverActions: { bodySizeLimit: "256kb" }
  },
  serverExternalPackages: ["@hmcts-cft/cloud-native-platform", "applicationinsights", "@prisma/client", "pg"],
  headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  }
};

export default nextConfig;
