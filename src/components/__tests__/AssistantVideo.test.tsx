/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedVideo, VideoPanel } from "@/components/assistant/VideoPanel";
import type { VideoDetail } from "@/components/assistant/videoClient";

const CONVERSATION = "33333333-3333-3333-3333-333333333333";
const VIDEO = "22222222-2222-4222-8222-222222222222";
const SUMMARY = { name: "pcs-journey", version: 1, updatedAt: "2026-11-18T12:00:00.000Z" };

function detail(overrides: Partial<VideoDetail> = {}): VideoDetail {
  return {
    video_id: VIDEO,
    name: "pcs-journey",
    bytes: 1000,
    has_captions: true,
    chapters: [
      { at: 0, title: "Sign in" },
      { at: 65, title: "Submit the claim" }
    ],
    coverage: "# Coverage\n\n2 of 3 stories and 7 ACs are shown.",
    coverage_summary: "2 of 3 stories and 7 ACs are shown.",
    content_mismatches: "# Mismatches\n\nNone.",
    jira_key: "HDPI-1234",
    posted: null,
    finished_at: "2026-11-18T12:00:00.000Z",
    play_url: "https://blobs.example/c/v.mp4?sig=x",
    expires_in: 3600,
    ...overrides
  };
}

function serve({ video = detail() as VideoDetail | null, jobs = [] as Record<string, unknown>[] } = {}) {
  const posts: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/ui/assistant/pod-jobs/")) {
      if (/\/job-1$/.test(url)) {
        return new Response(JSON.stringify(jobs.shift() ?? { job_id: "job-1", kind: "jira.attach-video", status: "pending" }));
      }
      posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ status: "pending", job_id: "job-1" }));
    }
    if (url === `/api/ui/assistant/video/${CONVERSATION}`) {
      return video === null ? new Response(JSON.stringify({ error: "none" }), { status: 404 }) : new Response(JSON.stringify(video));
    }
    return new Response("", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { posts, fetchMock };
}

const panel = (props: Partial<Parameters<typeof VideoPanel>[0]> = {}) => (
  <VideoPanel conversationId={CONVERSATION} video={SUMMARY} canPost narrow={false} announce={() => undefined} onClose={() => undefined} {...props} />
);

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  vi.stubGlobal("matchMedia", undefined);
  window.HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
  window.HTMLMediaElement.prototype.load = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the video panel's play URL", () => {
  /** A video whose every read is signed anew, as the hub's is. */
  function serveSigned(expiresIn = 3600) {
    let signed = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        signed += 1;
        return new Response(JSON.stringify(detail({ play_url: `https://blobs.example/v.mp4?sig=${signed}`, expires_in: expiresIn })));
      })
    );
    return () => signed;
  }

  it("should keep the URL the player has, when the page moves on and the video is the same", async () => {
    const signed = serveSigned();
    const { container, rerender } = render(panel());
    await settle();
    const player = container.querySelector("video") as HTMLVideoElement;
    expect(player.getAttribute("src")).toBe("https://blobs.example/v.mp4?sig=1");

    rerender(panel({ video: { ...SUMMARY, updatedAt: "2026-11-18T13:00:00.000Z" } }));
    await settle();

    expect(signed()).toBe(2);
    expect(container.querySelector("video")).toBe(player);
    expect(player.getAttribute("src")).toBe("https://blobs.example/v.mp4?sig=1");
    expect(window.HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1);
  });

  it("should take a new URL and carry on from where it was, when the player fails to play", async () => {
    serveSigned();
    const { container } = render(panel());
    await settle();
    const player = container.querySelector("video") as HTMLVideoElement;
    player.currentTime = 42;
    Object.defineProperty(player, "paused", { value: false, configurable: true });

    fireEvent.error(player);
    await settle();

    expect(player.getAttribute("src")).toBe("https://blobs.example/v.mp4?sig=2");
    player.currentTime = 0;
    fireEvent.loadedMetadata(player);
    expect(player.currentTime).toBe(42);
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it("should read a fresh URL before the one it has expires, when the panel stays open", async () => {
    vi.useFakeTimers();
    try {
      const signed = serveSigned(3600);
      const { container } = render(panel());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(signed()).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(56 * 60_000);
      });

      expect(signed()).toBe(2);
      expect((container.querySelector("video") as HTMLVideoElement).getAttribute("src")).toBe("https://blobs.example/v.mp4?sig=2");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the video panel", () => {
  it("should forget the last post and the issue key, when the video is replaced", async () => {
    serve({ jobs: [{ job_id: "job-1", kind: "k", status: "done", result: { issue_key: "HDPI-1234", url: "https://x/HDPI-1234", commented: true } }] });
    const { rerender } = render(panel());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Post to Jira" }));
    await settle();
    await settle();
    expect(screen.getByRole("link", { name: "HDPI-1234" })).toBeTruthy();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(detail({ video_id: "44444444-4444-4444-8444-444444444444", jira_key: "HDPI-9" }))))
    );
    rerender(panel({ video: { ...SUMMARY, version: 2 } }));
    await settle();

    expect(screen.queryByRole("link", { name: "HDPI-1234" })).toBeNull();
    expect((screen.getByLabelText("Jira issue") as HTMLInputElement).value).toBe("HDPI-9");
  });

  it("should play the video with its captions and list the chapters, when the video is read", async () => {
    serve();
    const { container } = render(panel());
    expect(screen.getByText("Loading the video…")).toBeTruthy();
    await settle();

    const player = container.querySelector("video") as HTMLVideoElement;
    expect(player.getAttribute("src")).toBe("https://blobs.example/c/v.mp4?sig=x");
    const track = container.querySelector("track") as HTMLTrackElement;
    expect(track.getAttribute("src")).toBe(`/api/ui/assistant/video/${CONVERSATION}/captions?v=${VIDEO}`);
    expect(track.getAttribute("kind")).toBe("captions");
    expect(screen.getByText("00:01:05")).toBeTruthy();
    expect(screen.getByText("Submit the claim")).toBeTruthy();
    expect(screen.getAllByText("Coverage").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Content mismatches").length).toBeGreaterThan(0);
  });

  it("should seek the player to a chapter and mark the chapter being played, when a chapter is pressed", async () => {
    serve();
    const { container } = render(panel());
    await settle();
    const player = container.querySelector("video") as HTMLVideoElement;

    fireEvent.click(screen.getByRole("button", { name: /Submit the claim/ }));
    expect(player.currentTime).toBe(65);
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
    fireEvent.timeUpdate(player);

    expect(screen.getByRole("button", { name: /Submit the claim/ }).getAttribute("aria-current")).toBe("true");
  });

  it("should leave out the track, the chapters and an empty report, when the recording has none", async () => {
    serve({ video: detail({ has_captions: false, chapters: [], content_mismatches: "  " }) });
    const { container } = render(panel());
    await settle();

    expect(container.querySelector("track")).toBeNull();
    expect(screen.queryByText("Chapters")).toBeNull();
    expect(screen.queryByText("Content mismatches")).toBeNull();
  });

  it("should offer to try again, when the video cannot be read", async () => {
    serve({ video: null });
    render(panel());
    await settle();

    expect(screen.getByText("The video could not be loaded.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(screen.getByText("The video could not be loaded.")).toBeTruthy();
  });

  it("should post the video to the issue the person confirms, and link it when it is done", async () => {
    const { posts } = serve({
      jobs: [
        {
          job_id: "job-1",
          kind: "jira.attach-video",
          status: "done",
          result: { issue_key: "HDPI-77", url: "https://hmcts.atlassian.net/browse/HDPI-77", commented: true }
        }
      ]
    });
    const announce = vi.fn();
    render(panel({ announce }));
    await settle();

    const field = screen.getByLabelText("Jira issue") as HTMLInputElement;
    expect(field.value).toBe("HDPI-1234");
    fireEvent.change(field, { target: { value: "hdpi-77" } });
    fireEvent.click(screen.getByRole("button", { name: "Post to Jira" }));
    await settle();
    await settle();

    expect(posts).toEqual([{ kind: "jira.attach-video", args: { issue_key: "HDPI-77", video_id: VIDEO } }]);
    expect(screen.getByRole("link", { name: "HDPI-77" }).getAttribute("href")).toBe("https://hmcts.atlassian.net/browse/HDPI-77");
    expect(announce).toHaveBeenCalledWith("The video is attached to HDPI-77");
  });

  it("should say the comment is missing, when only the comment failed", async () => {
    serve({ jobs: [{ job_id: "job-1", kind: "k", status: "done", result: { issue_key: "HDPI-1234", url: "https://x/HDPI-1234", commented: false } }] });
    render(panel());
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Post to Jira" }));
    await settle();
    await settle();

    expect(screen.getByText(/but the comment could not be added/)).toBeTruthy();
  });

  it("should say why, when the post fails", async () => {
    serve({ jobs: [{ job_id: "job-1", kind: "k", status: "failed", error: "issue_not_found" }] });
    render(panel());
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Post to Jira" }));
    await settle();
    await settle();

    expect(screen.getByRole("alert").textContent).toBe("Jira could not find that issue, or your account cannot see it.");
  });

  it("should not post when the key is not an issue key", async () => {
    const { posts } = serve({ video: detail({ jira_key: null }) });
    render(panel());
    await settle();

    const post = screen.getByRole("button", { name: "Post to Jira" }) as HTMLButtonElement;
    expect(post.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Jira issue"), { target: { value: "nope" } });
    fireEvent.submit(post.closest("form") as HTMLFormElement);
    expect(posts).toEqual([]);
  });

  it("should show where the video was last attached when it was posted before", async () => {
    serve({ video: detail({ posted: { key: "HDPI-5", url: "https://hmcts.atlassian.net/browse/HDPI-5", at: "2026-11-18T13:00:00.000Z" } }) });
    render(panel());
    await settle();

    expect(screen.getByText(/Last attached to/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "HDPI-5" })).toBeTruthy();
  });

  it("should have no post form and no close button, when it is a shared chat's read-only copy", async () => {
    serve();
    render(<SharedVideo conversationId={CONVERSATION} video={SUMMARY} />);
    await settle();

    expect(screen.queryByLabelText("Jira issue")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close video" })).toBeNull();
    expect(screen.getByText("Submit the claim")).toBeTruthy();
  });

  it("should close, when the close button is pressed", async () => {
    serve();
    const onClose = vi.fn();
    render(panel({ onClose }));
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Close video" }));
    expect(onClose).toHaveBeenCalled();
  });
});
