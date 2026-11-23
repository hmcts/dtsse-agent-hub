import { describe, expect, it } from "vitest";
import { describeBytes } from "../assistant/uploads.ts";
import { PROXY_BODY_LIMIT_BYTES } from "../port-viewer/forward.ts";
import { MAX_BULK_SCAN_FILE_BYTES, MAX_UPLOAD_BODY_BYTES, MULTIPART_OVERHEAD_BYTES } from "./limits.ts";

describe("upload limits", () => {
  it("should word the form's limit as the other upload refusals do when it is described to a person", () => {
    expect(describeBytes(MAX_BULK_SCAN_FILE_BYTES)).toBe("5 MB");
  });

  it("should add up to less than the proxy buffers of a request when the multipart framing is included", () => {
    expect(MAX_BULK_SCAN_FILE_BYTES + MULTIPART_OVERHEAD_BYTES).toBe(MAX_UPLOAD_BODY_BYTES);
    expect(MAX_UPLOAD_BODY_BYTES).toBeLessThan(PROXY_BODY_LIMIT_BYTES);
  });
});
