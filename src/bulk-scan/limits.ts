/**
 * What an upload of a form may weigh. The proxy truncates a request body above 6 MiB (`proxyClientMaxBodySize`), so the
 * file and the multipart framing around it and the case type id must add up to less than that, or the body arrives cut
 * short and cannot be read.
 */
export const MAX_BULK_SCAN_FILE_BYTES = 5 * 1024 * 1024;
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
export const MAX_UPLOAD_BODY_BYTES = MAX_BULK_SCAN_FILE_BYTES + MULTIPART_OVERHEAD_BYTES;

/** The longest case type id typed with an upload. */
export const MAX_CASE_TYPE_ID = 100;

/** A size as the messages word it: 5 MiB. */
export function mebibytes(bytes: number): string {
  return `${bytes / (1024 * 1024)} MiB`;
}
