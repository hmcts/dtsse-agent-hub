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
  // The proxy makes the hub's own trailing-slash redirect instead, because on the viewer's host a path belongs to
  // the agent's web server, for which `/docs/` and `/docs` can be different pages.
  skipTrailingSlashRedirect: true,
  // `next dev` prints every request's URL, query included; `next start` prints none. The proxy redirects these away,
  // but only after the original URL has been printed. Matches the names `carriesSecret` in src/auth/guard.ts refuses,
  // and the viewer's `ticket`.
  logging: { incomingRequests: { ignore: [/[?&](value|token|code|password|secret|ticket)=/i] } },
  // The sidebar's agent list is pinned to the bottom left, where the dev indicator sits by default.
  devIndicators: { position: "bottom-right" },
  experimental: {
    // The proxy buffers every matched request body in memory up to this size. The largest body the service accepts
    // is one part of an Assistant upload, PART_BYTES in src/assistant/uploads.ts (4 MiB), and this sits above it so
    // the part arrives whole; every other route stays bounded by the agent API's own MAX_REQUEST_BYTES, and a body
    // the proxy truncates is still long enough for `readJson` to refuse with a 413.
    proxyClientMaxBodySize: "6mb",
    // The largest action is a post or direct message, bounded by the same worst case as MAX_REQUEST_BYTES.
    serverActions: { bodySizeLimit: "256kb" }
  },
  serverExternalPackages: ["@hmcts-cft/cloud-native-platform", "applicationinsights", "@prisma/client", "pg"],
  // No `redirects()`. The hub's bare addresses are redirected from `src/proxy.ts` instead, because Next checks
  // config redirects ahead of the proxy and a 308 from here would repeat a pasted secret into its own `Location`,
  // before `carriesSecret` ever sees the request.
  headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  }
};

export default nextConfig;
