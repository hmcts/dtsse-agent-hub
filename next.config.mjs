const nextConfig = {
  output: "standalone",
  // Off for two reasons. The AAT front door stalls on an origin-compressed .css/.js (see dtsse-github-metrics'
  // next.config.mjs), and a compressing layer buffers an SSE response until it has enough bytes to emit, which
  // holds `/api/agent/*/stream` events and pings back from the client.
  compress: false,
  serverExternalPackages: ["@hmcts-cft/cloud-native-platform", "applicationinsights", "@prisma/client", "pg"]
};

export default nextConfig;
