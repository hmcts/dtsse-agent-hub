/**
 * What the pod says its own volume holds, and how the settings' Files section words it. Pure, and shared by the
 * pod-facing route, the store and the UI, so there is one answer to every question about the pod's disk.
 *
 * The hub cannot see that disk — every call between the two is pod to hub — and it deliberately does not guess from
 * its own rows: an `assistant_upload` row says a file was once fetched, not that the pod still has it. So everything
 * here is *as of* a report, and the states below exist so that "we have not heard" is never shown as an empty disk.
 */

/**
 * How many files one report names, largest first. The totals are of everything the pod holds, so a person is never
 * shown a sum of only these; what the cap bounds is the row the hub stores and the list it renders.
 */
export const MAX_REPORTED_FILES = 200;

/** As much as one `delete_uploads` frame names, which is a whole report's worth and no more. */
export const MAX_DELETED_PER_FRAME = MAX_REPORTED_FILES;

/** How often the pod reports, matching `RECONCILE_MS` in the client's `assistant/run.ts`, for wording "when". */
export const UPLOADS_REPORT_INTERVAL_MINUTES = 10;

/** One file the pod holds: the upload it is a copy of, and what it takes on disk. */
export type ReportedFile = {
  upload_id: string;
  bytes: number;
};

/** A pod's whole report. The two volume figures are of `/workspace`, which the repository clones share. */
export interface UploadsReport {
  uploads_bytes: number;
  volume_used_bytes: number;
  volume_total_bytes: number;
  files: ReportedFile[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A whole number of bytes a disk figure could be. Zero is allowed: an empty uploads directory is a real answer. */
export function isDiskSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

/**
 * The entries of a report this hub will store, in the order they arrived.
 *
 * An entry it cannot read is dropped rather than refusing the report: the whole report would otherwise be lost over
 * one file, and the totals — which are what the person is told — do not depend on the list. An `upload_id` with no
 * row of its own is kept here and left out of what the person sees, in `podFiles`, because they have nothing to call
 * it; it still counts towards the totals the pod sent, which is the truth about the disk.
 */
export function readReportedFiles(value: unknown): ReportedFile[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const files: ReportedFile[] = [];
  for (const entry of value.slice(0, MAX_REPORTED_FILES)) {
    const row = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : undefined;
    if (row !== undefined && typeof row.upload_id === "string" && UUID.test(row.upload_id) && isDiskSize(row.bytes)) {
      files.push({ upload_id: row.upload_id.toLowerCase(), bytes: row.bytes });
    }
  }
  return files;
}

const UNITS = ["bytes", "KB", "MB", "GB", "TB"] as const;

/**
 * A size a person reads: `0 bytes`, `812 KB`, `2.1 GB`. Powers of 1024, as every other size in the Assistant is,
 * and one decimal place from a megabyte up — a volume measured to the byte says nothing a person can act on.
 */
export function describeSize(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit <= 1 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded.toLocaleString("en-GB")} ${UNITS[unit]}`;
}

/** Why the hub has no figures to show, which is three different things and is told as three. */
export type NoUploadsReport =
  /** The pod runs a client from before it could report, so it will not until it next boots onto a newer one. */
  | "older_client"
  /** The pod is not running, so nothing has been able to look. */
  | "not_running"
  /** It is running and has simply not reported yet; the first one comes within the reconcile interval. */
  | "waiting";

/** What the Files section knows about the pod's disk: a report, or why there is none. */
export type UploadsDisk =
  | {
      reported: true;
      uploadsBytes: number;
      volumeUsedBytes: number;
      volumeTotalBytes: number;
      /** When the pod sent it, as an ISO instant. Always shown: these figures are never presented as current. */
      at: string;
      /** The pod is not running now, so nothing will update them until it is. */
      stopped: boolean;
    }
  | { reported: false; reason: NoUploadsReport };

export interface UploadsReportRow {
  uploadsBytes: bigint | null;
  volumeUsedBytes: bigint | null;
  volumeTotalBytes: bigint | null;
  uploadsReportedAt: Date | null;
  /** Whether the pod is running now, from the virtual agent's status. */
  running: boolean;
  /** Whether its current session's client claimed the `files` feature. */
  reports: boolean;
}

/**
 * What to show for the pod's disk. A report is shown whenever there is one, even from a stopped pod — the files are
 * still on the volume — but it says so, because nothing will move the figures until the pod is back.
 *
 * Without one the reason is the client first and the pod's state second: a pod running an older client would
 * otherwise read as one that is merely slow to answer, and the person would wait for a report that cannot come.
 */
export function uploadsDisk(row: UploadsReportRow): UploadsDisk {
  if (row.uploadsReportedAt !== null && row.uploadsBytes !== null && row.volumeUsedBytes !== null && row.volumeTotalBytes !== null) {
    return {
      reported: true,
      uploadsBytes: Number(row.uploadsBytes),
      volumeUsedBytes: Number(row.volumeUsedBytes),
      volumeTotalBytes: Number(row.volumeTotalBytes),
      at: row.uploadsReportedAt.toISOString(),
      stopped: !row.running
    };
  }
  if (!row.reports) {
    return { reported: false, reason: "older_client" };
  }
  return { reported: false, reason: row.running ? "waiting" : "not_running" };
}

/** One of the pod's files as the Files section lists it. */
export interface PodFile {
  uploadId: string;
  /** The person's own file name, from the upload row. */
  name: string;
  bytes: number;
  conversationId: string;
  /** The chat it was attached to, for saying which one a file belongs to. */
  conversationTitle: string;
  /** The owner has asked for it to go and the pod has not yet confirmed. */
  deleting: boolean;
}
