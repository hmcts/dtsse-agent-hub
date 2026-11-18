"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { formatStamp, JIRA_KEY_RE } from "@/assistant/video";
import type { VideoSummary } from "@/assistant/video-store";
import { AssistantMarkdown } from "@/components/assistant/AssistantMarkdown";
import { useSidebarWidth } from "@/components/assistant/AssistantShell";
import { ARTEFACT_MIN_WIDTH, CHAT_MIN_WIDTH } from "@/components/assistant/layout";
import { useResizableWidth } from "@/components/assistant/useResizableWidth";
import { captionsUrl, type PostOutcome, postFailureSentence, postVideo, readVideo, type VideoDetail } from "@/components/assistant/videoClient";
import { AnnouncerRegion, useAnnouncer } from "@/components/live/Announcer";
import { useHubSubscribe } from "@/components/live/HubStream";

const button = "flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-asst-strong px-2.5 text-[13px] hover:bg-asst-field disabled:opacity-40";

/** A play URL is replaced this long before it expires, so playback never reaches the end of one. */
const RENEW_MARGIN_MS = 5 * 60_000;

/**
 * The video as the hub holds it, read when the panel opens and again whenever the page says it has moved on. Every read
 * signs a new play URL, so a read of the same video keeps the URL the player already has while it has time left: a
 * change of `src` would restart the player. `renew` reads again for a fresh one, which the hook also asks for itself
 * before the current one expires.
 */
function useVideoDetail(conversationId: string, summary: VideoSummary): { detail: VideoDetail | null; failed: boolean; retry: () => void; renew: () => void } {
  const [read, setRead] = useState<{ detail: VideoDetail | null; failed: boolean }>({ detail: null, failed: false });
  const [attempt, setAttempt] = useState(0);
  const signed = useRef<{ id: string; url: string; expiresIn: number; at: number } | null>(null);
  const forced = useRef(false);
  const { version, updatedAt } = summary;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a newer version, an update, or another attempt is what makes the video worth reading again
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const fresh = await readVideo(conversationId, { signal: controller.signal });
        if (fresh === undefined) {
          setRead({ detail: null, failed: true });
          return;
        }
        const held = signed.current;
        const keep = !forced.current && held !== null && held.id === fresh.video_id && Date.now() < held.at + held.expiresIn * 1000 - RENEW_MARGIN_MS;
        forced.current = false;
        if (keep) {
          setRead({ detail: { ...fresh, play_url: held.url, expires_in: held.expiresIn }, failed: false });
        } else {
          signed.current = { id: fresh.video_id, url: fresh.play_url, expiresIn: fresh.expires_in, at: Date.now() };
          setRead({ detail: fresh, failed: false });
        }
      } catch {
        if (!controller.signal.aborted) {
          setRead((previous) => ({ detail: previous.detail, failed: true }));
        }
      }
    })();
    return () => controller.abort();
  }, [conversationId, version, updatedAt, attempt]);
  const renew = useCallback(() => {
    forced.current = true;
    setAttempt((count) => count + 1);
  }, []);
  const playUrl = read.detail?.play_url;
  const expiresIn = read.detail?.expires_in ?? 0;
  useEffect(() => {
    if (playUrl === undefined) {
      return;
    }
    const timer = setTimeout(renew, Math.max(expiresIn * 1000 - RENEW_MARGIN_MS, 0));
    return () => clearTimeout(timer);
  }, [playUrl, expiresIn, renew]);
  return { ...read, retry: () => setAttempt((count) => count + 1), renew };
}

function PanelShell({ narrow, embedded, children }: { narrow: boolean; embedded: boolean; children: ReactNode }) {
  const sidebarWidth = useSidebarWidth();
  const resize = useResizableWidth({
    storageKey: "hmcts-assistant-video-width",
    label: "Resize video panel",
    initial: 760,
    min: ARTEFACT_MIN_WIDTH,
    reserve: () => CHAT_MIN_WIDTH + sidebarWidth,
    edge: "right"
  });
  return (
    <section
      aria-label="Journey video"
      className={
        embedded
          ? "flex h-full min-h-0 w-full flex-col bg-asst-panel"
          : `z-[25] flex h-full shrink-0 flex-col border-l border-asst-line bg-asst-panel ${narrow ? "fixed inset-0" : "relative"}`
      }
      style={narrow || embedded ? undefined : { width: resize.width }}
    >
      {narrow || embedded ? null : (
        <div
          {...resize.separator}
          className="absolute -left-1 bottom-0 top-0 z-[2] w-2 cursor-col-resize hover:bg-asst-accent/25 focus:bg-asst-accent/40 focus:outline-hidden"
        />
      )}
      {children}
    </section>
  );
}

function Header({ title, embedded, onClose }: { title: string; embedded: boolean; onClose: () => void }) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-asst-field pl-4 pr-3">
      <span aria-hidden="true" className="shrink-0 font-plex-mono text-[11px] uppercase tracking-wider text-asst-accent-soft">
        .mp4
      </span>
      <h2 className="min-w-0 flex-1 truncate text-[15px] font-medium text-asst-text">{title}</h2>
      {embedded ? null : (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close video"
          className="h-8 w-8 shrink-0 rounded-lg text-xl leading-none text-asst-muted hover:bg-asst-field hover:text-asst-text"
        >
          ×
        </button>
      )}
    </div>
  );
}

type Post =
  | { phase: "idle" }
  | { phase: "waking" | "pending" }
  | { phase: "done"; issueKey: string; url: string; commented: boolean }
  | { phase: "failed"; message: string };

function PostToJira({ conversationId, detail, announce }: { conversationId: string; detail: VideoDetail; announce: (text: string) => void }) {
  const [key, setKey] = useState(detail.jira_key ?? "");
  const [post, setPost] = useState<Post>({ phase: "idle" });
  const podJobs = useHubSubscribe("assistant_pod_job");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const issueKey = key.trim().toUpperCase();
  const valid = JIRA_KEY_RE.test(issueKey);
  const busy = post.phase === "waking" || post.phase === "pending";

  const send = useCallback(async () => {
    controller.current?.abort();
    const mine = new AbortController();
    controller.current = mine;
    setPost({ phase: "pending" });
    let outcome: PostOutcome;
    try {
      outcome = await postVideo(
        conversationId,
        { issueKey, videoId: detail.video_id },
        {
          signal: mine.signal,
          events: podJobs,
          onWaking: () => setPost({ phase: "waking" }),
          onPending: () => setPost({ phase: "pending" })
        }
      );
    } catch {
      if (!mine.signal.aborted) {
        setPost({ phase: "failed", message: "The post did not finish. Try again." });
      }
      return;
    }
    if (mine.signal.aborted) {
      return;
    }
    if (outcome.status === "done") {
      setPost({ phase: "done", issueKey: outcome.issueKey, url: outcome.url, commented: outcome.commented });
      announce(`The video is attached to ${outcome.issueKey}`);
    } else {
      setPost({ phase: "failed", message: postFailureSentence(outcome) });
    }
  }, [conversationId, detail.video_id, issueKey, podJobs, announce]);

  const done = post.phase === "done" ? post : null;
  const earlier = done === null ? detail.posted : null;
  return (
    <section aria-label="Post to Jira" className="border-t border-asst-field px-4 py-3">
      <form
        method="post"
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !busy) {
            void send();
          }
        }}
      >
        <label htmlFor="video-issue-key" className="text-[13px] text-asst-muted">
          Jira issue
        </label>
        <input
          id="video-issue-key"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="HDPI-1234"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={key.trim() !== "" && !valid}
          className="h-[30px] w-32 rounded-lg border border-asst-strong bg-asst-field px-2 font-plex-mono text-[13px] text-asst-text"
        />
        <button type="submit" disabled={!valid || busy} className={button}>
          {busy ? (post.phase === "waking" ? "Starting your assistant…" : "Posting…") : "Post to Jira"}
        </button>
      </form>
      <p className="mt-1.5 text-[12px] text-asst-muted">Attaches the video to that issue and comments with its chapters and coverage.</p>
      {done === null ? null : (
        <p role="status" className="mt-2 text-[13px] text-asst-text">
          Attached to{" "}
          <a href={done.url} target="_blank" rel="noreferrer" className="text-asst-accent underline">
            {done.issueKey}
          </a>
          {done.commented ? "." : ", but the comment could not be added."}
        </p>
      )}
      {earlier === null ? null : (
        <p className="mt-2 text-[13px] text-asst-muted">
          Last attached to{" "}
          <a href={earlier.url} target="_blank" rel="noreferrer" className="text-asst-accent underline">
            {earlier.key}
          </a>
          .
        </p>
      )}
      {post.phase === "failed" ? (
        <p role="alert" className="mt-2 text-[13px] text-red-400">
          {post.message}
        </p>
      ) : null}
    </section>
  );
}

function Report({ title, summary, source }: { title: string; summary?: string | null; source: string }) {
  if (source.trim() === "") {
    return null;
  }
  return (
    <details className="rounded-lg border border-asst-line">
      <summary className="cursor-pointer px-3 py-2 text-[13px] font-medium text-asst-text">
        {title}
        {summary ? <span className="ml-2 font-normal text-asst-muted">{summary}</span> : null}
      </summary>
      <div className="overflow-x-auto border-t border-asst-line px-3 py-2 text-[13px]">
        <AssistantMarkdown source={source} document />
      </div>
    </details>
  );
}

function Player({ conversationId, detail, renew }: { conversationId: string; detail: VideoDetail; renew: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const loaded = useRef<{ id: string; url: string } | null>(null);
  /** A failure is put down to an expired URL once; one that follows a fresh URL is the file's, and is left to the player. */
  const renewed = useRef(false);
  const [broken, setBroken] = useState(false);
  const [now, setNow] = useState(0);
  const current = detail.chapters.reduce((found, chapter, index) => (chapter.at <= now ? index : found), -1);

  // The source is set here and not as a prop, so a new URL for the same video carries on from where it was.
  useEffect(() => {
    const element = video.current;
    const held = loaded.current;
    if (element === null || (held !== null && held.url === detail.play_url)) {
      return;
    }
    const resume = held !== null && held.id === detail.video_id ? { at: element.currentTime, playing: !element.paused } : null;
    loaded.current = { id: detail.video_id, url: detail.play_url };
    element.src = detail.play_url;
    if (resume !== null) {
      element.addEventListener(
        "loadedmetadata",
        () => {
          element.currentTime = resume.at;
          if (resume.playing) {
            void element.play().catch(() => undefined);
          }
        },
        { once: true }
      );
    }
    element.load();
  }, [detail.play_url, detail.video_id]);

  const seek = (at: number) => {
    const element = video.current;
    if (element === null) {
      return;
    }
    element.currentTime = at;
    void element.play().catch(() => undefined);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* The captions come from the hub's own origin, so the track needs nothing from the storage account. A recording made without captions has none to give. */}
      {/* biome-ignore lint/a11y/useMediaCaption: the track is there whenever the recording has captions */}
      <video
        ref={video}
        key={detail.video_id}
        controls
        preload="metadata"
        onTimeUpdate={(event) => setNow(event.currentTarget.currentTime)}
        onLoadedData={() => {
          renewed.current = false;
          setBroken(false);
        }}
        onError={() => {
          if (renewed.current) {
            setBroken(true);
          } else {
            renewed.current = true;
            renew();
          }
        }}
        className="max-h-[60vh] w-full rounded-lg bg-black"
      >
        {detail.has_captions ? <track kind="captions" src={captionsUrl(conversationId, detail.video_id)} srcLang="en" label="English" default /> : null}
      </video>
      {broken ? (
        <p role="alert" className="text-[13px] text-red-400">
          The video could not be played.
        </p>
      ) : null}
      {detail.chapters.length === 0 ? null : (
        <nav aria-label="Chapters">
          <h3 className="mb-1 text-[12px] font-medium uppercase tracking-wider text-asst-muted">Chapters</h3>
          <ol className="flex flex-col">
            {detail.chapters.map((chapter, index) => (
              <li key={`${chapter.at}-${chapter.title}`}>
                <button
                  type="button"
                  onClick={() => seek(chapter.at)}
                  aria-current={index === current ? "true" : undefined}
                  className={`flex w-full items-baseline gap-3 rounded-md px-2 py-1 text-left text-[13px] hover:bg-asst-field ${index === current ? "bg-asst-field text-asst-text" : "text-asst-muted"}`}
                >
                  <span className="shrink-0 font-plex-mono text-[12px]">{formatStamp(chapter.at)}</span>
                  <span className="min-w-0">{chapter.title}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}
    </div>
  );
}

export function VideoPanel({
  conversationId,
  video,
  canPost,
  onClose,
  narrow,
  announce,
  embedded = false
}: {
  conversationId: string;
  video: VideoSummary;
  /** Whether the viewer owns the chat and it has a pod of its own, which is what posting to Jira runs on. */
  canPost: boolean;
  onClose: () => void;
  narrow: boolean;
  announce: (text: string) => void;
  /** Fills the box it is placed in instead of standing beside the chat at a width the person sets. */
  embedded?: boolean;
}) {
  const { detail, failed, retry, renew } = useVideoDetail(conversationId, video);
  return (
    <PanelShell narrow={narrow} embedded={embedded}>
      <Header title={video.name} embedded={embedded} onClose={onClose} />
      {detail === null ? (
        <div className="px-4 py-5 text-[13px] text-asst-muted">
          {failed ? (
            <>
              <p>The video could not be loaded.</p>
              <button type="button" onClick={retry} className={`${button} mt-2`}>
                Try again
              </button>
            </>
          ) : (
            <p>Loading the video…</p>
          )}
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
            <Player conversationId={conversationId} detail={detail} renew={renew} />
            <Report title="Coverage" summary={detail.coverage_summary} source={detail.coverage} />
            <Report title="Content mismatches" source={detail.content_mismatches} />
          </div>
          {canPost ? <PostToJira key={detail.video_id} conversationId={conversationId} detail={detail} announce={announce} /> : null}
        </>
      )}
    </PanelShell>
  );
}

/** The video on a shared chat's page, read-only, in a box of its own where the shared template would be. */
export function SharedVideo({ conversationId, video }: { conversationId: string; video: VideoSummary }) {
  const region = useAnnouncer("video");
  return (
    <div className="h-[min(720px,85vh)] overflow-hidden rounded-2xl border border-asst-line">
      <VideoPanel conversationId={conversationId} video={video} canPost={false} narrow={false} announce={region.announce} onClose={() => undefined} embedded />
      <AnnouncerRegion text={region.text} />
    </div>
  );
}
