/**
 * What an upload of a form and its CCD definition may weigh. The proxy truncates a request body above 6 MiB
 * (`proxyClientMaxBodySize`), so the two files and the multipart framing must add up to less than that or the body
 * arrives cut short and cannot be read.
 */
export const MAX_BULK_SCAN_FILE_BYTES = 4.5 * 1024 * 1024;
/** A CaseField.json is about 120 KiB. */
export const MAX_CCD_DEFINITION_BYTES = 1024 * 1024;
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
export const MAX_UPLOAD_BODY_BYTES = MAX_BULK_SCAN_FILE_BYTES + MAX_CCD_DEFINITION_BYTES + MULTIPART_OVERHEAD_BYTES;
