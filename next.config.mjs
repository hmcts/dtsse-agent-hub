const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // frame-ancestors only: a default-src or script-src would block the inline scripts Next renders.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }
];

/**
 * The hub's pages are served under `/hub`, and each also answers on its bare address with a 308. Those bare addresses
 * are what people paste into chats and tickets — `/agents/{id}` is the one URL for any agent, local or virtual — so a
 * 404 there is a regression even though no code links to them.
 *
 * One rule per segment, never a catch-all: `/`, `/assistant`, `/auth/…`, `/api/…` and `/health…` must not be matched.
 * Redirects are checked before the filesystem, so a catch-all would shadow the front door.
 */
const HUB_SEGMENTS = ["access", "agents", "c", "channels", "m", "settings", "topics", "virtual"];

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
  },
  redirects() {
    // Both forms per segment: `:path*` matches zero segments, but only the exact source keeps `/access` off a
    // trailing slash and so out of a second hop.
    return HUB_SEGMENTS.flatMap((segment) => [
      { source: `/${segment}`, destination: `/hub/${segment}`, permanent: true },
      { source: `/${segment}/:path*`, destination: `/hub/${segment}/:path*`, permanent: true }
    ]);
  }
};

export default nextConfig;
