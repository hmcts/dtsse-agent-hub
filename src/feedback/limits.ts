/** The bounds of prototype feedback, shared by the request schemas, the stores and the pages. The migration checks the same. */

export const MAX_PROJECT_NAME = 120;
export const MAX_LINK_LABEL = 80;
export const MAX_TARGET_URL = 2048;
export const MAX_PROTOTYPE_VERSION = 100;
export const MAX_PAGE_PATH = 2048;
export const MAX_COMMENT = 10_000;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 365;
export const DEFAULT_RETENTION_DAYS = 90;

/** Links one project holds, live and revoked alike. */
export const MAX_LINKS_PER_PROJECT = 20;
/** People on one project's team besides its owner. */
export const MAX_MEMBERS = 50;

/** The longest recording, which also bounds every offset into one. */
export const MAX_RECORDING_MS = 2 * 60 * 60 * 1000;
/** Segment numbers run 0–9999 per kind, about 28 hours of 10-second audio, so `MAX_RECORDING_MS` is what binds. */
export const MAX_SEGMENT_SEQ = 9999;
/** One uploaded segment, which the upload SAS does not bound, so the row and the player do. */
export const MAX_SEGMENT_BYTES = 25 * 1024 * 1024;

/**
 * What one person may do through one link in `FEEDBACK_RATE_WINDOW_MS`, taken under a lock on the link's row so two
 * tabs cannot both find room. Per person rather than per link, so a whole research session sharing one link is not
 * limited by its busiest reviewer; each is far beyond what someone typing or clicking makes.
 */
export const FEEDBACK_RATE_WINDOW_MS = 10 * 60 * 1000;
export const MAX_THREADS_PER_WINDOW = 60;
export const MAX_COMMENTS_PER_WINDOW = 120;
export const MAX_RECORDINGS_PER_WINDOW = 10;
/** Segments one person may ask to upload through one link in the window: 10-second audio and replay chunks for it all. */
export const MAX_SEGMENTS_PER_WINDOW = 400;

export const FEEDBACK_RATE_LIMITED = "that is a lot at once; wait a moment and try again";

/** How long an archived project is kept, links already dead, before the sweep deletes it and its blobs. */
export const ARCHIVED_PROJECT_DAYS = 7;
