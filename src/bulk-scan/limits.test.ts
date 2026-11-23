import { describe, expect, it } from "vitest";
import { MAX_BULK_SCAN_FILE_BYTES, MAX_CCD_DEFINITION_BYTES, MAX_UPLOAD_BODY_BYTES, MULTIPART_OVERHEAD_BYTES } from "./limits.ts";

/** `proxyClientMaxBodySize` in next.config.mjs: the proxy truncates a request body above it. */
const PROXY_BODY_CAP = 6 * 1024 * 1024;

describe("upload limits", () => {
  it("should add up, with the multipart framing, to less than the proxy buffers of a request", () => {
    expect(MAX_BULK_SCAN_FILE_BYTES + MAX_CCD_DEFINITION_BYTES + MULTIPART_OVERHEAD_BYTES).toBe(MAX_UPLOAD_BODY_BYTES);
    expect(MAX_UPLOAD_BODY_BYTES).toBeLessThan(PROXY_BODY_CAP);
  });
});
