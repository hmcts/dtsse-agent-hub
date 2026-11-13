import "server-only";
import { HttpError } from "../agent-api/http.ts";
import type { MentionablePerson } from "../feedback/mentions.ts";
import { projectsLastActive } from "../feedback/nav-store.ts";
import { type FeedbackRecordingDetail, type FeedbackRecordingView, getRecording, listRecordings, recordingPages } from "../feedback/recording-store.ts";
import { type FeedbackProjectSummary, type FeedbackProjectView, getProject, listProjects, mentionablePeople } from "../feedback/store.ts";
import { type FeedbackThreadView, listThreads } from "../feedback/thread-store.ts";
import { prisma } from "../store/prisma.ts";
import type { Identity } from "../users/identity.ts";

/**
 * The reads the team's feedback pages make, beside `data.ts` and under the same rule: each takes the viewer, and the
 * stores it calls apply `src/access/`. A project the viewer is not on the team of reads as `undefined`, which the page
 * renders as not found, as it does one that does not exist.
 */

export interface FeedbackProjectRow extends FeedbackProjectSummary {
  /** As the sidebar dates it; see `projectsLastActive`. */
  lastActivityAt: string;
}

export async function feedbackProjects(viewer: Identity, includeArchived: boolean): Promise<FeedbackProjectRow[]> {
  const projects = await listProjects(prisma, viewer.oid, { includeArchived });
  if (projects.length === 0) {
    return [];
  }
  const latest = await projectsLastActive(
    prisma,
    projects.map((project) => project.id)
  );
  return projects.map((project) => ({ ...project, lastActivityAt: (latest.get(project.id) ?? new Date(project.updatedAt)).toISOString() }));
}

export interface FeedbackRecordingRow extends FeedbackRecordingView {
  pages: string[];
  comments: number;
}

export interface FeedbackProjectPageData {
  project: FeedbackProjectView;
  threads: FeedbackThreadView[];
  recordings: FeedbackRecordingRow[];
  /** Who a reply may `@` name. */
  people: MentionablePerson[];
}

async function orMissing<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

export async function feedbackProjectPage(viewer: Identity, projectId: string): Promise<FeedbackProjectPageData | undefined> {
  return await orMissing(async () => {
    const project = await getProject(prisma, viewer.oid, projectId);
    const scope = { projectId: project.id };
    const [threads, recordings, people] = await Promise.all([
      listThreads(prisma, viewer.oid, scope),
      listRecordings(prisma, viewer.oid, scope),
      mentionablePeople(prisma, project.id)
    ]);
    const pages = await recordingPages(
      prisma,
      recordings.map((recording) => recording.id)
    );
    const comments = new Map<string, number>();
    for (const thread of threads) {
      if (thread.recordingId !== null) {
        comments.set(thread.recordingId, (comments.get(thread.recordingId) ?? 0) + 1);
      }
    }
    return {
      project,
      threads,
      people,
      recordings: recordings.map((recording) => ({ ...recording, pages: pages.get(recording.id) ?? [], comments: comments.get(recording.id) ?? 0 }))
    };
  });
}

export interface FeedbackRecordingPageData {
  project: FeedbackProjectView;
  recording: FeedbackRecordingDetail;
  /** The threads made during the recording, for its markers. */
  threads: FeedbackThreadView[];
  people: MentionablePerson[];
}

export async function feedbackRecordingPage(viewer: Identity, projectId: string, recordingId: string): Promise<FeedbackRecordingPageData | undefined> {
  return await orMissing(async () => {
    const project = await getProject(prisma, viewer.oid, projectId);
    const scope = { projectId: project.id };
    const [recording, threads, people] = await Promise.all([
      getRecording(prisma, viewer.oid, scope, recordingId),
      listThreads(prisma, viewer.oid, scope),
      mentionablePeople(prisma, project.id)
    ]);
    return { project, recording, people, threads: threads.filter((thread) => thread.recordingId === recording.id) };
  });
}
