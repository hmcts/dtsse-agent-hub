"use client";

import type { FeedbackRecordingPageData } from "@/web/feedback-data";
import { when } from "./look";
import { type ProjectActions, useThreadHandlers } from "./ProjectPage";
import { RecordingPlayer } from "./RecordingPlayer";

/** The recording page's body: when and where it was made, and the player. */
export function RecordingView({ data, actions }: Readonly<{ data: FeedbackRecordingPageData; actions: Pick<ProjectActions, "reply" | "setStatus"> }>) {
  const handlers = useThreadHandlers(data.project.id, actions);
  const link = data.project.links.find((l) => l.id === data.recording.linkId);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-asst-muted">
        <time dateTime={data.recording.startedAt}>{when(data.recording.startedAt)}</time>
        {link === undefined ? null : ` · ${link.label}`}
        {data.recording.prototypeVersion === null ? null : ` · version ${data.recording.prototypeVersion}`}
      </p>
      {data.recording.status === "ready" ? (
        <RecordingPlayer projectId={data.project.id} recording={data.recording} threads={data.threads} people={data.people} handlers={handlers} />
      ) : (
        <p className="text-[13px] text-asst-muted">
          {data.recording.status === "recording"
            ? "This recording is still being made. It can be played once the reviewer stops it."
            : "This recording did not finish, so it cannot be played."}
        </p>
      )}
    </div>
  );
}
