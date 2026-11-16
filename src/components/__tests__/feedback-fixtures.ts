import type { FeedbackRecordingDetail } from "@/feedback/recording-store";
import type { FeedbackProjectView } from "@/feedback/store";
import type { FeedbackThreadView } from "@/feedback/thread-store";
import type { FeedbackProjectPageData, FeedbackRecordingRow } from "@/web/feedback-data";

/** The team-side feedback shapes the component suites render, each with what a test changes overridable. */

export const ANN = { oid: "ann", name: "Ann Reviewer" };
export const BEN = { oid: "ben", name: "Ben Reviewer" };
export const OWNER = { oid: "olive", name: "Olive Owner", email: "olive@example.com" };

export function project(more: Partial<FeedbackProjectView> = {}): FeedbackProjectView {
  return {
    id: "p1",
    name: "Apply for a thing",
    owner: OWNER,
    access: "owner",
    maskInputs: false,
    retentionDays: 90,
    archivedAt: null,
    createdAt: "2026-11-01T09:00:00.000Z",
    updatedAt: "2026-11-01T09:00:00.000Z",
    links: [
      {
        id: "l1",
        label: "Round 1",
        targetUrl: "https://proto.example.com/start",
        origin: "https://proto.example.com",
        token: "tok-one",
        prototypeVersion: "v3",
        revokedAt: null,
        createdAt: "2026-11-01T09:00:00.000Z"
      }
    ],
    members: [{ oid: "mo", name: "Mo Member", email: null }],
    ...more
  };
}

export function thread(id: string, more: Partial<FeedbackThreadView> = {}): FeedbackThreadView {
  const author = more.author ?? ANN;
  const createdAt = more.createdAt ?? "2026-11-10T10:00:00.000Z";
  return {
    id,
    projectId: "p1",
    linkId: "l1",
    pagePath: "/start",
    anchor: { selector: `#${id}`, text: `text of ${id}`, tag: "p", rect: { x: 10, y: 100, width: 200, height: 20 }, viewport: { width: 1000, height: 800 } },
    status: "open",
    author,
    resolvedBy: null,
    resolvedAt: null,
    snapshotBlob: `p1/snapshots/${id}.json.gz`,
    recordingId: null,
    offsetMs: null,
    prototypeVersion: null,
    createdAt,
    updatedAt: createdAt,
    comments: [{ id: `${id}-c1`, author, body: `Comment ${id}`, createdAt, mentions: [] }],
    ...more
  };
}

export function recordingRow(id: string, more: Partial<FeedbackRecordingRow> = {}): FeedbackRecordingRow {
  return {
    id,
    projectId: "p1",
    linkId: "l1",
    author: BEN,
    startedAt: "2026-11-11T09:00:00.000Z",
    endedAt: "2026-11-11T09:05:00.000Z",
    durationMs: 185_000,
    status: "ready",
    prototypeVersion: null,
    pages: ["/start", "/details"],
    comments: 1,
    ...more
  };
}

export function recordingDetail(more: Partial<FeedbackRecordingDetail> = {}): FeedbackRecordingDetail {
  const { pages: _pages, comments: _comments, ...row } = recordingRow("r1");
  return {
    ...row,
    durationMs: 30_000,
    segments: [
      { id: "s-a0", kind: "audio", seq: 0, pagePath: null, blobPath: "a/0", offsetMs: 0, bytes: 10 },
      { id: "s-r0", kind: "replay", seq: 0, pagePath: "/start", blobPath: "r/0", offsetMs: 0, bytes: 10 },
      { id: "s-r1", kind: "replay", seq: 1, pagePath: "/details", blobPath: "r/1", offsetMs: 15_000, bytes: 10 }
    ],
    markers: [{ threadId: "t1", offsetMs: 12_000, pagePath: "/start" }],
    ...more
  };
}

export function pageData(more: Partial<FeedbackProjectPageData> = {}): FeedbackProjectPageData {
  return {
    project: project(),
    threads: [thread("t1"), thread("t2", { author: BEN, status: "resolved" })],
    recordings: [recordingRow("r1")],
    people: [ANN, BEN],
    ...more
  };
}
