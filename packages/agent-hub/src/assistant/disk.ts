// What this pod's volume holds, reported to the hub because the hub cannot see it: every call between the two is pod
// to hub. The uploads are only a share of `/workspace`, which the repository clones are on as well, so both figures
// are sent — "2.1 GB of files" says much less than "2.1 GB of files, on a volume that is 28 of 32 GB full", and the
// second is the one that explains why something has started going wrong.
import nodeFs from "node:fs";
import path from "node:path";
import type { UploadsReportBody } from "../api.ts";
import type { Env } from "../env.ts";
import { type AttachmentFs, uploadsRoot } from "./attachments.ts";

/** As many files as one report names, largest first; `MAX_REPORTED_FILES` in the service's upload-report.ts. */
export const MAX_REPORTED_FILES = 200;

const UUID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i;

/** The upload a written file is a copy of, from the name `attachmentPath` gave it. */
export function uploadIdOf(name: string): string | undefined {
  return UUID.exec(name)?.[1]?.toLowerCase();
}

/** The attachment filesystem plus the one call only this module makes; a test passes `node:fs` or its own. */
export type DiskFs = AttachmentFs & Pick<typeof nodeFs, "statfsSync">;

export type UploadsDiskOptions = {
  root?: string;
  fs?: DiskFs;
  env?: Env;
  say?: (message: string) => void;
};

/**
 * Walks the uploads root and measures the volume under it.
 *
 * One level of directories, then their files: that is the whole shape `fetchAttachments` writes, so there is no
 * recursion to bound. A file whose name carries no upload id still counts towards the total — it is bytes on the
 * volume — and is simply not listed, since the hub would have nothing to match it to.
 *
 * `undefined` when it cannot measure the volume. Reporting the uploads with a volume of zero would be worse than
 * reporting nothing: the hub would show a full disk as empty, and nothing would say the figure was a guess.
 */
export function measureUploads({ root, fs = nodeFs as DiskFs, env = process.env, say = () => {} }: UploadsDiskOptions = {}): UploadsReportBody | undefined {
  const base = root ?? uploadsRoot(env);
  let volume: { used: number; total: number };
  try {
    const stat = fs.statfsSync(base);
    const size = Number(stat.bsize);
    volume = { used: (Number(stat.blocks) - Number(stat.bfree)) * size, total: Number(stat.blocks) * size };
  } catch (e) {
    say(`could not measure the volume at ${base}: ${(e as Error).message}`);
    return undefined;
  }
  const files: { upload_id: string; bytes: number }[] = [];
  let uploadsBytes = 0;
  if (fs.existsSync(base)) {
    for (const conversation of fs.readdirSync(base) as string[]) {
      const dir = path.join(base, conversation);
      let names: string[];
      try {
        names = fs.readdirSync(dir) as string[];
      } catch {
        // Not a directory, or removed between the listing and this read. Neither is this module's to report on.
        continue;
      }
      for (const name of names) {
        let bytes: number;
        try {
          bytes = fs.statSync(path.join(dir, name)).size;
        } catch {
          continue;
        }
        uploadsBytes += bytes;
        const uploadId = uploadIdOf(name);
        if (uploadId !== undefined) {
          files.push({ upload_id: uploadId, bytes });
        }
      }
    }
  }
  // Largest first, so a report that has to be cut names the files worth deleting. A plain `.sort()` would order the
  // numbers as strings.
  files.sort((a, b) => b.bytes - a.bytes || (a.upload_id < b.upload_id ? -1 : a.upload_id > b.upload_id ? 1 : 0));
  return {
    uploads_bytes: uploadsBytes,
    volume_used_bytes: volume.used,
    volume_total_bytes: volume.total,
    // How many there are, so the hub says a list was cut only when it was. The cap is on what is named, not counted.
    files_total: files.length,
    files: files.slice(0, MAX_REPORTED_FILES),
    deleted: []
  };
}

export type ReportUploadsOptions = UploadsDiskOptions & {
  api: { putUploads: (virtualId: string, body: UploadsReportBody) => Promise<null> };
  id: string;
  /** The deletions to acknowledge with this report: the ids whose copies this pod has confirmed are gone. */
  deleted?: readonly string[];
};

/**
 * Measures and reports, acknowledging whatever deletions it is given. Answers what it sent, or `undefined` when
 * there was nothing to send or the hub refused it.
 *
 * A failed report is not retried here: the next reconcile measures again, and figures 10 minutes old are better than
 * figures from a retry of a measurement that is by then stale. The hub's own wording is what keeps that honest — it
 * always says when the pod last reported rather than presenting the numbers as current. A lost acknowledgement costs
 * nothing either: the hub asks for the deletion again when this pod's stream next opens, and deleting a file that is
 * already gone is a deletion that has happened.
 */
export async function reportUploads({ api, id, deleted = [], ...options }: ReportUploadsOptions): Promise<UploadsReportBody | undefined> {
  const say = options.say ?? (() => {});
  const measured = measureUploads(options);
  if (measured === undefined) {
    return undefined;
  }
  const report = { ...measured, deleted: [...deleted] };
  try {
    await api.putUploads(id, report);
    return report;
  } catch (e) {
    say(`could not report what the uploads volume holds: ${(e as Error).message}`);
    return undefined;
  }
}
