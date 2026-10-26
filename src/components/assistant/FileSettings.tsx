"use client";

import type { UploadsOnDisk } from "@/assistant/upload-disk";
import { describeSize, MAX_REPORTED_FILES, type PodFile, UPLOADS_REPORT_INTERVAL_MINUTES, type UploadsDisk } from "@/assistant/upload-report";
import { ActionForm, type FormAction } from "@/components/ActionForm";
import { Timestamp } from "@/components/time/Timestamp";

/**
 * The files on the person's assistant's own volume, as the Assistant's settings show them: the one report
 * `assistantFiles` reads and the two actions that ask for a deletion. Every figure, cap and refusal is
 * `src/assistant/upload-report.ts`'s and `upload-disk.ts`'s, so nothing is decided a second time here.
 */
export interface AssistantFiles {
  view: UploadsOnDisk;
  remove: FormAction;
  removeAll: FormAction;
}

const LINK = "text-xs text-asst-muted underline hover:text-asst-text";

/** Why there are no figures, in words that do not read as "you have no files". */
const NO_REPORT: Record<Exclude<UploadsDisk, { reported: true }>["reason"], string> = {
  older_client: "Your assistant is running an older version that cannot tell us what it is holding. It can the next time it starts.",
  not_running: "Your assistant is stopped, so nothing has been able to look at its disk. It reports when it next starts.",
  waiting: `Your assistant has not reported yet. It checks every ${UPLOADS_REPORT_INTERVAL_MINUTES} minutes.`
};

/**
 * The two numbers, never one. The uploads are a share of a volume the repository clones are on as well, so "2.1 GB
 * of files" says far less than "2.1 GB of files, on a volume that is 28.4 GB of 32 GB full" — and the second is the
 * figure that explains why something has started going wrong.
 *
 * It always says when the pod last looked, and never presents the figures as current: the hub has no way to see that
 * disk between reports.
 */
function Disk({ disk }: { disk: UploadsDisk }) {
  if (!disk.reported) {
    return <p className="text-pretty text-[13px] text-asst-warn">{NO_REPORT[disk.reason]}</p>;
  }
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-asst-line bg-asst-raised px-3.5 py-3">
      <p className="text-sm font-semibold">{describeSize(disk.uploadsBytes)} of files</p>
      <p className="text-[13px] text-asst-body">
        On a disk that is {describeSize(disk.volumeUsedBytes)} of {describeSize(disk.volumeTotalBytes)} full. Your assistant's own work — the repositories it
        clones — takes up the rest.
      </p>
      <p className="text-xs text-asst-muted">
        {disk.stopped ? "Your assistant is stopped. Last reported " : "Last reported "}
        <Timestamp iso={disk.at} />.
      </p>
    </div>
  );
}

function Row({ file, remove }: { file: PodFile; remove: FormAction }) {
  return (
    <li className="flex items-center gap-3 border-b border-asst-line px-3.5 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm font-medium">{file.name}</span>
        <span className="truncate text-xs text-asst-muted">
          {describeSize(file.bytes)} · {file.conversationTitle}
        </span>
      </div>
      {file.deleting ? (
        // Not "deleted": the pod is what removes its own copy, and until its next report says so this is a request.
        <span className="shrink-0 text-xs text-asst-muted">Waiting for your assistant</span>
      ) : (
        <ActionForm action={remove} label={`Delete ${file.name}`} className="shrink-0">
          <input type="hidden" name="id" value={file.uploadId} />
          <button type="submit" aria-label={`Delete ${file.name}`} className={LINK}>
            Delete
          </button>
        </ActionForm>
      )}
    </li>
  );
}

/**
 * The Files section of the Assistant's settings.
 *
 * It is about the copies on the assistant's own disk, which are what accumulate: the hub holds an attached file's
 * bytes for three hours and then lets them go, while the assistant keeps its copy until the chat is deleted. So this
 * lists what the assistant says it has, and deleting asks the assistant to remove its copy.
 *
 * Every piece of wording here is about which copy goes, because the two are easy to confuse and a button that left
 * gigabytes behind would be worse than no button. The hub's own copy goes at once, which is why the chat's download
 * stops working; the assistant's goes when it next checks, which is what the confirmation promises.
 */
export function Files({ files }: { files: AssistantFiles }) {
  const { view, remove, removeAll } = files;
  return (
    <section aria-labelledby="assistant-settings-files" className="flex flex-col gap-2.5">
      <h3 id="assistant-settings-files" className="text-sm font-semibold">
        Files
      </h3>
      <p className="text-pretty text-[13px] text-asst-muted">
        Files you have attached to a chat, which your assistant keeps on its own disk so it can go back to them. They stay until you delete them or delete the
        chat.
      </p>
      <Disk disk={view.disk} />
      {view.files.length === 0 ? (
        view.disk.reported ? (
          <p className="text-[13px] text-asst-muted">Your assistant is holding no files.</p>
        ) : null
      ) : (
        <>
          <ul aria-label="Files on your assistant" className="flex flex-col overflow-hidden rounded-[10px] border border-asst-line">
            {view.files.map((file) => (
              <Row key={file.uploadId} file={file} remove={remove} />
            ))}
          </ul>
          {view.truncated ? (
            <p className="text-xs text-asst-muted">The largest {MAX_REPORTED_FILES.toLocaleString("en-GB")} are listed. The size above is of everything.</p>
          ) : null}
          <ActionForm action={removeAll} label="Delete every file your assistant is holding" className="flex flex-col gap-2">
            <p className="text-pretty text-[13px] text-asst-body">
              Deleting removes your assistant's copy, which is what takes up the space. Each chat still shows that a file was attached, and the hub drops any
              copy of its own, so a recent file can no longer be downloaded back from the chat.
            </p>
            <button
              type="submit"
              className="self-start rounded-[10px] border border-asst-error px-3.5 py-2 text-[13px] font-semibold text-asst-error hover:bg-asst-active"
            >
              Delete every file
            </button>
          </ActionForm>
        </>
      )}
      {view.deleting === 0 ? null : (
        <p className="text-xs text-asst-muted">
          {view.deleting.toLocaleString("en-GB")} {view.deleting === 1 ? "file is" : "files are"} waiting for your assistant to delete.
        </p>
      )}
    </section>
  );
}
