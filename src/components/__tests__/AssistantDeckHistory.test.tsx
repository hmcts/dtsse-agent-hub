/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetRef, type DeckOutline } from "@/assistant/deck";
import type { DeckBuildView } from "@/assistant/deck-build";
import type { DeckVersionEntry, DeckVersionView } from "@/assistant/deck-history-store";
import type { DeckView } from "@/assistant/deck-store";
import {
  BUILD_POLL_FAILURES,
  DeckDownload,
  DeckHistory,
  deckBuildUrl,
  deckVersionsUrl,
  deckVersionUrl,
  LATEST_BUILD_GRACE_MS,
  type RestoreDeckAction
} from "@/components/assistant/DeckHistory";
import { SharedDeck } from "@/components/assistant/DeckPanel";
import { deckPptxUrl } from "@/components/assistant/deck-addresses";

const CONVERSATION = "22222222-2222-2222-2222-222222222222";
const SHA = "c".repeat(64);
const JOB = "33333333-3333-4333-8333-333333333333";

let clicked: string[] = [];

beforeEach(() => {
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this.getAttribute("href") ?? "");
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const LATEST_OUTLINE: DeckOutline = {
  title: "Ways of working",
  slides: [
    { id: "why", layout: "HMCTS_SECTION", title: "Why this matters" },
    { id: "what", layout: "HMCTS_CONTENT", title: "What to do", bullets: ["Build", "Test", "Ship"] },
    { id: "pic", layout: "HMCTS_IMAGE", title: "Our pipeline", image: { asset: assetRef(SHA), alt: "Five stages" } }
  ]
};

const OLD_OUTLINE: DeckOutline = {
  title: "Ways of working",
  slides: [
    { id: "what", layout: "HMCTS_CONTENT", title: "What to do", bullets: ["Build", "Test"] },
    { id: "why", layout: "HMCTS_SECTION", title: "Why it matters" },
    { id: "gone", layout: "HMCTS_SECTION", title: "An old aside" }
  ]
};

function latest(overrides: Partial<DeckView> = {}): DeckView {
  return {
    title: "Ways of working",
    outline: LATEST_OUTLINE,
    version: 7,
    updatedBy: "agent",
    updatedAt: "2026-11-03T09:00:00.000Z",
    pptx: true,
    sizes: { [SHA]: { width: 1200, height: 600 } },
    ...overrides
  };
}

const VERSIONS: DeckVersionEntry[] = [
  { version: 7, by: "agent", summary: "Added the pipeline", created_at: "2026-11-03T09:00:00.000Z", updated_at: "2026-11-03T09:00:00.000Z", pptx: true },
  { version: 6, by: "user", summary: "Restored version 4", created_at: "2026-11-02T15:30:00.000Z", updated_at: "2026-11-02T15:30:00.000Z", pptx: false },
  { version: 5, by: "agent", summary: null, created_at: "2026-11-01T10:00:00.000Z", updated_at: "2026-11-01T10:00:00.000Z", pptx: false }
];

function old(version = 5, overrides: Partial<DeckVersionView> = {}): DeckVersionView {
  const entry = VERSIONS.find((one) => one.version === version) ?? VERSIONS[2]!;
  return { ...entry, title: "Ways of working", outline: OLD_OUTLINE, sizes: {}, ...overrides };
}

type Answer = { status?: number; body: unknown } | (() => { status?: number; body: unknown });

/** The routes, answered by address and method; anything else is a 404. */
function serving(routes: Record<string, Answer>) {
  const reads = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const route = routes[key];
    const answer = typeof route === "function" ? route() : route;
    return answer === undefined
      ? new Response(JSON.stringify({ error: "no" }), { status: 404 })
      : new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  });
  vi.stubGlobal("fetch", reads);
  return reads;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function history(props: Partial<Parameters<typeof DeckHistory>[0]> = {}) {
  const announce = vi.fn();
  render(<DeckHistory conversationId={CONVERSATION} latest={latest()} announce={announce} owner {...props} />);
  return announce;
}

async function openHistory(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  await settle();
}

describe("DeckHistory's list", () => {
  it("should open the list of versions as buttons, newest first, with the one on screen current", async () => {
    // Arrange
    const reads = serving({ [`GET ${deckVersionsUrl(CONVERSATION)}`]: { body: VERSIONS } });
    const announce = history();
    const toggle = screen.getByRole("button", { name: "History" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    // Act
    await openHistory();

    // Assert
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("list", { name: "Versions" });
    expect(toggle.getAttribute("aria-controls")).toBe(list.closest("section")?.id);
    const items = within(list).getAllByRole("button");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^Version 7 \(latest\)Assistant, 3 Nov 2026, \d\d:00Added the pipeline$/),
      expect.stringMatching(/^Version 6You, 2 Nov 2026, \d\d:30Restored version 4$/),
      expect.stringMatching(/^Version 5Assistant, 1 Nov 2026, \d\d:00$/)
    ]);
    expect(items[0]?.getAttribute("aria-current")).toBe("true");
    expect(items[1]?.getAttribute("aria-current")).toBeNull();
    expect(announce).toHaveBeenCalledWith("Version history opened");
    expect(reads).toHaveBeenCalledWith(deckVersionsUrl(CONVERSATION), expect.objectContaining({ cache: "no-store" }));
  });

  it("should say who wrote a version as the chat's owner to someone it is shared with", async () => {
    // Arrange
    serving({ [`GET ${deckVersionsUrl(CONVERSATION)}`]: { body: VERSIONS } });
    history({ owner: false });

    // Act
    await openHistory();

    // Assert
    expect(screen.getAllByRole("button", { name: /^Version 6/ })[0]?.textContent).toContain("The chat's owner");
  });

  it("should say it could not load the history, and read it again when asked", async () => {
    // Arrange
    let calls = 0;
    serving({ [`GET ${deckVersionsUrl(CONVERSATION)}`]: () => (calls++ === 0 ? { status: 500, body: {} } : { body: VERSIONS }) });
    history();

    // Act
    await openHistory();
    expect(screen.getByRole("alert").textContent).toContain("Could not load the history.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();

    // Assert
    expect(screen.getAllByRole("button", { name: /^Version / })).toHaveLength(3);
  });

  it("should read the list again when the latest version is amended, its number staying the same", async () => {
    // Arrange
    const amended: DeckVersionEntry[] = [{ ...VERSIONS[0]!, by: "user", summary: "Reordered slides", pptx: false }, ...VERSIONS.slice(1)];
    let calls = 0;
    const reads = serving({ [`GET ${deckVersionsUrl(CONVERSATION)}`]: () => ({ body: calls++ === 0 ? VERSIONS : amended }) });
    const { rerender } = render(<DeckHistory conversationId={CONVERSATION} latest={latest({ revision: 3 })} announce={vi.fn()} owner />);
    await openHistory();
    expect(screen.getAllByRole("button", { name: /^Version 7/ })[0]?.textContent).toContain("Added the pipeline");

    // Act
    rerender(<DeckHistory conversationId={CONVERSATION} latest={latest({ revision: 4, updatedBy: "user", pptx: false })} announce={vi.fn()} owner />);
    await settle();

    // Assert
    expect(reads).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole("button", { name: /^Version 7/ })[0]?.textContent).toContain("Reordered slides");
  });

  it("should close the list again, and say so", async () => {
    // Arrange
    serving({ [`GET ${deckVersionsUrl(CONVERSATION)}`]: { body: VERSIONS } });
    const announce = history();
    await openHistory();

    // Act
    fireEvent.click(screen.getByRole("button", { name: "History" }));

    // Assert
    expect(screen.queryByRole("list", { name: "Versions" })).toBeNull();
    expect(announce).toHaveBeenLastCalledWith("Version history closed");
  });
});

describe("DeckHistory's older version", () => {
  function routes(extra: Record<string, Answer> = {}) {
    return serving({
      [`GET ${deckVersionsUrl(CONVERSATION)}`]: { body: VERSIONS },
      [`GET ${deckVersionUrl(CONVERSATION, 5)}`]: { body: old() },
      ...extra
    });
  }

  it("should show the version picked read-only under a banner saying it is not the latest, and go back to the latest", async () => {
    // Arrange
    routes();
    const onAsk = vi.fn();
    const announce = history({ onAsk });
    await openHistory();

    // Act
    fireEvent.click(screen.getByRole("button", { name: /^Version 5/ }));
    await settle();

    // Assert
    expect(screen.getByText("Viewing version 5 (not the latest)")).toBeTruthy();
    expect(within(screen.getByRole("toolbar", { name: "Slides" })).getByText("Version 5")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Version 5/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.queryByRole("button", { name: "Ask about this slide" })).toBeNull();
    expect(screen.getByRole("region", { name: /^Slide 1 of 4/ })).toBeTruthy();
    expect(announce).toHaveBeenCalledWith("Showing version 5, not the latest");

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Back to latest" }));

    // Assert
    expect(screen.queryByText(/Viewing version/)).toBeNull();
    expect(within(screen.getByRole("toolbar", { name: "Slides" })).getByText("Version 7")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask about this slide" })).toBeTruthy();
    expect(announce).toHaveBeenLastCalledWith("Showing the latest version, version 7");
  });

  it("should go back to the latest when the latest is picked from the list", async () => {
    // Arrange
    routes();
    const announce = history();
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: /^Version 5/ }));
    await settle();

    // Act
    fireEvent.click(screen.getByRole("button", { name: /^Version 7/ }));

    // Assert
    expect(screen.queryByText(/Viewing version/)).toBeNull();
    expect(announce).toHaveBeenLastCalledWith("Showing the latest version, version 7");
  });

  it("should say it could not load a version, with a way back to the latest", async () => {
    // Arrange
    routes({ [`GET ${deckVersionUrl(CONVERSATION, 5)}`]: { status: 404, body: {} } });
    history();
    await openHistory();

    // Act
    fireEvent.click(screen.getByRole("button", { name: /^Version 5/ }));
    await settle();

    // Assert
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Could not load version 5.");
    fireEvent.click(within(alert).getByRole("button", { name: "Back to latest" }));
    expect(screen.getByText("Version 7")).toBeTruthy();
  });

  it("should compare the version with the latest, marking each slide in words as well as an icon", async () => {
    // Arrange
    routes();
    const announce = history();
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: /^Version 5/ }));
    await settle();

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Compare with latest" }));

    // Assert
    const compared = screen.getByRole("region", { name: "Version 5 compared with the latest" });
    expect(within(compared).getByRole("heading", { name: "Version 5 compared with the latest, version 7" })).toBeTruthy();
    expect(compared.textContent).toContain("2 slides changed, 1 slide added, 1 slide removed and 1 slide moved.");
    const entries = within(within(compared).getByRole("list", { name: "Differences" })).getAllByRole("listitem");
    expect(entries.map((entry) => within(entry).getByRole("heading").textContent)).toEqual([
      "Slide 3, now slide 2: Why this matters",
      "Slide 4: An old aside",
      "Slide 2, now slide 3: What to do",
      "Slide 4: Our pipeline"
    ]);
    expect(entries.map((entry) => entry.querySelector(".rounded-full")?.textContent)).toEqual(["✎Changed", "−Removed", "✎↕Changed and moved", "+Added"]);
    // The words that changed are marked as such for a screen reader too, not only by their style.
    const title = within(entries[0]!).getByText("Title").nextElementSibling as HTMLElement;
    expect(title.querySelector("del")?.textContent).toBe("removed: it");
    expect(title.querySelector("ins")?.textContent).toBe("added: this");
    const bullets = within(entries[2]!).getByText("Bullets").nextElementSibling as HTMLElement;
    expect(bullets.querySelector("ins")?.textContent).toBe("added: Ship");
    // A changed slide is drawn in both versions.
    expect(
      within(entries[0]!)
        .getAllByRole("figure")
        .map((figure) => figure.querySelector("figcaption")?.textContent)
    ).toEqual(["Version 5", "Latest, version 7"]);
    expect(announce).toHaveBeenLastCalledWith("Comparing version 5 with the latest. 2 slides changed, 1 slide added, 1 slide removed and 1 slide moved");

    // Act
    fireEvent.click(within(compared).getByRole("button", { name: "Back to version 5" }));

    // Assert
    expect(screen.queryByRole("region", { name: "Version 5 compared with the latest" })).toBeNull();
    expect(within(screen.getByRole("toolbar", { name: "Slides" })).getByText("Version 5")).toBeTruthy();
  });

  it("should say the title slide changed when the outline's own title did", async () => {
    // Arrange
    routes({ [`GET ${deckVersionUrl(CONVERSATION, 5)}`]: { body: old(5, { outline: { ...LATEST_OUTLINE, title: "Ways of shipping" } }) } });
    history();
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: /^Version 5/ }));
    await settle();

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Compare with latest" }));

    // Assert
    expect(screen.getByRole("heading", { name: "Slide 1: the title slide" })).toBeTruthy();
    expect(screen.getByText(/^The title slide changed\.$/)).toBeTruthy();
  });

  it("should restore the version on top of the latest the page shows, and go back to the latest", async () => {
    // Arrange
    routes();
    const restore = vi.fn<RestoreDeckAction>(async () => ({ ok: true, restored: true, version: 8 }));
    const announce = history({ restore });
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: /^Version 5/ }));
    await settle();

    // Act
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    });

    // Assert
    expect(restore).toHaveBeenCalledWith({ conversationId: CONVERSATION, version: 5, baseVersion: 7 });
    expect(announce).toHaveBeenLastCalledWith("Restored version 5 as version 8");
    expect(screen.queryByText(/Viewing version/)).toBeNull();
  });

  it("should say nothing was restored when the slides changed meanwhile", async () => {
    // Arrange
    routes();
    const restore = vi.fn<RestoreDeckAction>(async () => ({ ok: true, restored: false, current: { version: 9, updatedBy: "agent" } }));
    history({ restore });
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: /^Version 5/ }));
    await settle();

    // Act
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    });

    // Assert
    expect(screen.getByRole("alert").textContent).toBe(
      "The slides changed while you were looking: they are now version 9. Nothing was restored. Look at the latest, then try again."
    );
    expect(screen.getByText("Viewing version 5 (not the latest)")).toBeTruthy();
  });

  it("should show the action's refusal when the restore is refused", async () => {
    // Arrange
    routes();
    const restore = vi.fn<RestoreDeckAction>(async () => ({ ok: false, error: "that version of the slides is not there" }));
    history({ restore });
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: /^Version 5/ }));
    await settle();

    // Act
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    });

    // Assert
    expect(screen.getByRole("alert").textContent).toBe("Couldn't restore version 5: that version of the slides is not there");
  });

  it("should say the restore failed when the action throws, and offer it again", async () => {
    // Arrange
    routes();
    const restore = vi.fn<RestoreDeckAction>(async () => Promise.reject(new Error("An unexpected response was received from the server.")));
    history({ restore });
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: /^Version 5/ }));
    await settle();

    // Act
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    });

    // Assert
    expect(screen.getByRole("alert").textContent).toBe("Couldn't restore version 5. Try again.");
    expect((screen.getByRole("button", { name: "Restore this version" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("Viewing version 5 (not the latest)")).toBeTruthy();
  });

  it("should offer someone it is shared with the history but no restore and no build", async () => {
    // Arrange
    routes();
    history({ owner: false, restore: vi.fn() });
    await openHistory();

    // Act
    fireEvent.click(screen.getByRole("button", { name: /^Version 5/ }));
    await settle();

    // Assert
    expect(screen.queryByRole("button", { name: "Restore this version" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Prepare .pptx" })).toBeNull();
    expect(screen.getByText("Not available")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compare with latest" })).toBeTruthy();
  });

  it("should offer a shared page's reader the history read-only", async () => {
    // Arrange
    serving({
      [`GET /api/ui/assistant/decks/${CONVERSATION}`]: { body: latest() },
      [`GET ${deckVersionsUrl(CONVERSATION)}`]: { body: VERSIONS },
      [`GET ${deckVersionUrl(CONVERSATION, 5)}`]: { body: old() }
    });
    render(<SharedDeck conversationId={CONVERSATION} deck={{ title: "Ways of working", version: 7, revision: 7, updatedBy: "agent", pptx: true }} />);
    await settle();

    // Act
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: /^Version 5/ }));
    await settle();

    // Assert
    expect(screen.getByText("Viewing version 5 (not the latest)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore this version" })).toBeNull();
    expect(screen.getByText("Not available")).toBeTruthy();
  });
});

describe("DeckHistory with a layout the viewer no longer has", () => {
  const STALE_OUTLINE = {
    title: "Ways of working",
    slides: [
      { id: "why", layout: "HMCTS_SECTION", title: "Why it matters" },
      { id: "quote", layout: "HMCTS_QUOTE", title: "In their words", quote: "Ship small", bullets: ["Often", { text: "Safely", bullets: ["With tests"] }] }
    ]
  } as unknown as DeckOutline;

  it("should say which layout an older version uses that the viewer cannot draw, and show its slides as text", async () => {
    // Arrange
    serving({
      [`GET ${deckVersionsUrl(CONVERSATION)}`]: { body: VERSIONS },
      [`GET ${deckVersionUrl(CONVERSATION, 5)}`]: { body: old(5, { outline: STALE_OUTLINE }) }
    });
    history();
    await openHistory();

    // Act
    fireEvent.click(screen.getByRole("button", { name: /^Version 5/ }));
    await settle();

    // Assert
    expect(screen.getByRole("alert").textContent).toBe("Version 5 uses a layout this viewer no longer has (HMCTS_QUOTE). Its slides are shown as text.");
    const text = screen.getByRole("list", { name: "Slides as text" });
    expect(within(text).getByText("In their words").textContent).toBe("Slide 3: In their words");
    expect(within(text).getByText("Ship small")).toBeTruthy();
    expect(within(text).getByText("With tests")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to latest" })).toBeTruthy();
  });

  it("should compare such a version in words, without drawing its slides", async () => {
    // Arrange
    serving({
      [`GET ${deckVersionsUrl(CONVERSATION)}`]: { body: VERSIONS },
      [`GET ${deckVersionUrl(CONVERSATION, 5)}`]: { body: old(5, { outline: STALE_OUTLINE }) }
    });
    history();
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: /^Version 5/ }));
    await settle();

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Compare with latest" }));

    // Assert
    expect(screen.getByRole("alert").textContent).toBe(
      "Version 5 uses a layout this viewer no longer has (HMCTS_QUOTE). Its slides are compared in words only."
    );
    expect(screen.getByRole("list", { name: "Differences" })).toBeTruthy();
  });

  it("should show the latest version as text too when it is the one using such a layout", () => {
    // Arrange and act
    history({ latest: latest({ outline: STALE_OUTLINE }) });

    // Assert
    expect(screen.getByRole("alert").textContent).toContain("Version 7 uses a layout this viewer no longer has (HMCTS_QUOTE).");
    expect(screen.getByRole("button", { name: "History" })).toBeTruthy();
  });
});

describe("DeckDownload", () => {
  function shown(props: Partial<Parameters<typeof DeckDownload>[0]> = {}) {
    const announce = vi.fn();
    render(<DeckDownload conversationId={CONVERSATION} version={5} pptx={false} canBuild latest={false} announce={announce} pollMs={50} {...props} />);
    return announce;
  }

  const POST = `POST ${deckPptxUrl(CONVERSATION, 5)}`;
  const POLL = `GET ${deckBuildUrl(CONVERSATION, JOB)}`;

  it("should link to the .pptx the hub holds", () => {
    shown({ pptx: true });
    expect(screen.getByRole("link", { name: "Download .pptx" }).getAttribute("href")).toBe(deckPptxUrl(CONVERSATION, 5));
  });

  it("should say Not built yet for the latest, and Not available for an older one, to someone who cannot build", () => {
    shown({ canBuild: false, latest: true });
    expect(screen.getByText("Not built yet")).toBeTruthy();
    cleanup();
    shown({ canBuild: false });
    expect(screen.getByText("Not available")).toBeTruthy();
  });

  it("should prepare the .pptx, read the build back until it is done, and then download it", async () => {
    // Arrange
    let polls = 0;
    const done: DeckBuildView = { status: "done", job_id: JOB, version: 5 };
    const pending: DeckBuildView = { status: "pending", job_id: JOB, version: 5 };
    serving({ [POST]: { body: { status: "pending", job_id: JOB } }, [POLL]: () => ({ body: polls++ === 0 ? pending : done }) });
    const announce = shown();

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Prepare .pptx" }));
    await settle();

    // Assert
    expect(screen.getByRole("status").textContent).toBe("Preparing…");
    expect(announce).toHaveBeenCalledWith("Preparing version 5");
    await vi.waitFor(() => expect(screen.getByRole("link", { name: "Download .pptx" })).toBeTruthy(), { timeout: 2000 });
    expect(polls).toBe(2);
    expect(clicked).toEqual([deckPptxUrl(CONVERSATION, 5)]);
    expect(announce).toHaveBeenLastCalledWith("Version 5 is ready to download");
  });

  it("should download straight away when the hub already holds the .pptx", async () => {
    // Arrange
    serving({ [POST]: { body: { status: "ready" } } });
    shown();

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Prepare .pptx" }));
    await settle();

    // Assert
    expect(clicked).toEqual([deckPptxUrl(CONVERSATION, 5)]);
    expect(screen.getByRole("link", { name: "Download .pptx" })).toBeTruthy();
  });

  it("should show why a build failed, and start another when asked to try again", async () => {
    // Arrange
    let posts = 0;
    serving({
      [POST]: () => {
        posts += 1;
        return { body: { status: "pending", job_id: JOB } };
      },
      [POLL]: { body: { status: "failed", job_id: JOB, version: 5, error: "This version could not be built: slide 3: the picture is missing" } }
    });
    const announce = shown();

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Prepare .pptx" }));
    await settle();
    await vi.waitFor(() => expect(screen.getByRole("alert")).toBeTruthy(), { timeout: 2000 });

    // Assert
    expect(screen.getByRole("alert").textContent).toBe("This version could not be built: slide 3: the picture is missingTry again");
    expect(announce).toHaveBeenLastCalledWith("Version 5 could not be prepared");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(posts).toBe(2);
  });

  it("should say a build that took too long did", async () => {
    // Arrange
    serving({ [POST]: { body: { status: "pending", job_id: JOB } }, [POLL]: { body: { status: "timeout", job_id: JOB, version: 5 } } });
    shown();

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Prepare .pptx" }));
    await settle();

    // Assert
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Building this version took too long."), { timeout: 2000 });
  });

  it.each([
    ["waking", "Your assistant is starting up. Try again in a minute."],
    ["unsupported", "Your assistant needs an update before it can build this version. It gets one the next time it restarts."],
    ["assistant_gone", "This chat's assistant has been replaced, so older versions can't be prepared here."],
    ["no_pod", "Older versions can only be prepared in a chat that runs on your assistant in the hub, not in a chat from your own machine."]
  ])("should say why nothing was started when the hub answers %s", async (status, words) => {
    // Arrange
    serving({ [POST]: { body: { status } } });
    shown();

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Prepare .pptx" }));
    await settle();

    // Assert
    expect(screen.getByRole("alert").textContent).toBe(`${words}Try again`);
  });

  it("should say to restart the assistant, and link to the restart in its settings, when the hub answers restart_needed", async () => {
    // Arrange
    serving({ [POST]: { body: { status: "restart_needed" } } });
    shown();

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Prepare .pptx" }));
    await settle();

    // Assert
    expect(screen.getByRole("alert").textContent).toBe("Restart your assistant to load the slide tools, then try again.Restart it in SettingsTry again");
    expect(screen.getByRole("link", { name: "Restart it in Settings" }).getAttribute("href")).toBe("?settings=assistant");
  });

  it("should show the hub's refusal, and a fault, as a failure to try again", async () => {
    // Arrange
    serving({ [POST]: { status: 409, body: { error: "turn on Slides in Settings, under Plugins, first" } } });
    shown();

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Prepare .pptx" }));
    await settle();

    // Assert
    expect(screen.getByRole("alert").textContent).toBe("turn on Slides in Settings, under Plugins, firstTry again");

    // Arrange
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline")))
    );

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();

    // Assert
    expect(screen.getByRole("alert").textContent).toBe("This version could not be prepared.Try again");
  });

  describe("reading a build back", () => {
    async function start(poll: Answer) {
      vi.useFakeTimers();
      const reads = serving({ [POST]: { body: { status: "pending", job_id: JOB } }, [POLL]: poll });
      const announce = vi.fn();
      const view = render(<DeckDownload conversationId={CONVERSATION} version={5} pptx={false} canBuild latest={false} announce={announce} pollMs={2000} />);
      fireEvent.click(screen.getByRole("button", { name: "Prepare .pptx" }));
      await settle();
      const polls = () => reads.mock.calls.filter(([url]) => url === deckBuildUrl(CONVERSATION, JOB)).length;
      return { announce, polls, view };
    }

    const tick = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };

    /** A build whose every read back takes `ms` to answer `done`, with the signal each read was made with. */
    async function slowly(ms: number) {
      vi.useFakeTimers();
      const signals: AbortSignal[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          if (init?.method === "POST") {
            return new Response(JSON.stringify({ status: "pending", job_id: JOB }));
          }
          signals.push(init!.signal!);
          return await new Promise<Response>((resolve) => {
            setTimeout(() => resolve(new Response(JSON.stringify({ status: "done", job_id: JOB, version: 5 }))), ms);
          });
        })
      );
      const announce = vi.fn();
      const view = render(<DeckDownload conversationId={CONVERSATION} version={5} pptx={false} canBuild latest={false} announce={announce} pollMs={2000} />);
      fireEvent.click(screen.getByRole("button", { name: "Prepare .pptx" }));
      await settle();
      return { announce, signals, view };
    }

    it("should not read again while a slow read is unanswered, and download once when it answers", async () => {
      // Arrange
      const { announce, signals } = await slowly(7000);

      // Act
      await tick(2000);
      await tick(6000);
      const waiting = signals.length;
      await tick(1000);
      await tick(10_000);

      // Assert
      expect(waiting).toBe(1);
      expect(signals).toHaveLength(1);
      expect(clicked).toEqual([deckPptxUrl(CONVERSATION, 5)]);
      expect(announce.mock.calls.filter(([text]) => text === "Version 5 is ready to download")).toHaveLength(1);
      expect(screen.getByRole("link", { name: "Download .pptx" })).toBeTruthy();
    });

    it("should abort a read still unanswered when it is taken off the page, and not download", async () => {
      // Arrange
      const { signals, view } = await slowly(7000);
      await tick(2000);

      // Act
      view.unmount();
      await tick(20_000);

      // Assert
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
      expect(clicked).toEqual([]);
    });

    it("should stop, and offer another try, when the build has gone", async () => {
      // Arrange
      const { announce, polls } = await start({ status: 404, body: { error: "not found" } });

      // Act
      await tick(2000);
      await tick(10_000);

      // Assert
      expect(polls()).toBe(1);
      expect(screen.getByRole("alert").textContent).toBe("This build is no longer there.Try again");
      expect(announce).toHaveBeenLastCalledWith("Version 5 could not be prepared");
    });

    it("should stop after reads fail one after another, but not before", async () => {
      // Arrange
      const { polls } = await start({ status: 500, body: { error: "boom" } });

      // Act
      await tick(2000 * (BUILD_POLL_FAILURES - 1));
      const before = screen.queryByRole("alert");
      await tick(2000);
      await tick(10_000);

      // Assert
      expect(before).toBeNull();
      expect(polls()).toBe(BUILD_POLL_FAILURES);
      expect(screen.getByRole("alert").textContent).toBe("Could not check on this build.Try again");
    });

    it("should count only failures in a row", async () => {
      // Arrange
      let read = 0;
      await start(() => {
        read += 1;
        return read % BUILD_POLL_FAILURES === 0 ? { body: { status: "pending", job_id: JOB, version: 5 } } : { status: 500, body: { error: "boom" } };
      });

      // Act
      await tick(2000 * BUILD_POLL_FAILURES * 2);

      // Assert
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("status").textContent).toBe("Preparing…");
    });

    it("should stop once it has waited as long as the hub does, 15 minutes", async () => {
      // Arrange
      const { polls } = await start({ body: { status: "pending", job_id: JOB, version: 5 } });

      // Act
      await tick(15 * 60_000 - 2000);
      const before = screen.queryByRole("alert");
      await tick(2000);
      const asked = polls();
      await tick(10_000);

      // Assert
      expect(before).toBeNull();
      expect(screen.getByRole("alert").textContent).toBe("Building this version took too long.Try again");
      expect(polls()).toBe(asked);
    });

    it("should stop reading when it is taken off the page", async () => {
      // Arrange
      const { polls, view } = await start({ body: { status: "pending", job_id: JOB, version: 5 } });
      await tick(2000);
      const asked = polls();

      // Act
      view.unmount();
      await tick(20_000);

      // Assert
      expect(asked).toBe(1);
      expect(polls()).toBe(1);
    });
  });

  describe("the latest version", () => {
    it("should say the assistant is building it, with no build to start, until two minutes after it was written", async () => {
      // Arrange
      vi.useFakeTimers({ now: new Date("2026-11-03T09:01:00.000Z") });
      shown({ latest: true, writtenAt: "2026-11-03T09:00:00.000Z" });

      // Assert
      expect(screen.getByText("The assistant is building this")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Prepare .pptx" })).toBeNull();

      // Act
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LATEST_BUILD_GRACE_MS / 2);
      });

      // Assert
      expect(screen.getByRole("button", { name: "Prepare .pptx" })).toBeTruthy();
      expect(screen.queryByText("The assistant is building this")).toBeNull();
    });

    it("should offer a build of it straight away when it was written more than two minutes ago", () => {
      // Arrange
      vi.useFakeTimers({ now: new Date("2026-11-03T09:05:00.000Z") });

      // Act
      shown({ latest: true, writtenAt: "2026-11-03T09:00:00.000Z" });

      // Assert
      expect(screen.getByRole("button", { name: "Prepare .pptx" })).toBeTruthy();
    });

    it("should offer a build of an older version however recently it was written", () => {
      // Arrange
      vi.useFakeTimers({ now: new Date("2026-11-03T09:00:30.000Z") });

      // Act
      shown({ latest: false, writtenAt: "2026-11-03T09:00:00.000Z" });

      // Assert
      expect(screen.getByRole("button", { name: "Prepare .pptx" })).toBeTruthy();
    });

    it("should say the assistant is building it in the history when the assistant wrote it", () => {
      // Arrange
      vi.useFakeTimers({ now: new Date("2026-11-03T09:00:30.000Z") });

      // Act
      history({ latest: latest({ updatedBy: "agent", pptx: false }) });

      // Assert
      expect(screen.getByText("The assistant is building this")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Prepare .pptx" })).toBeNull();
    });

    it("should offer a build of it straight away in the history when the person wrote it, which no session builds", () => {
      // Arrange
      vi.useFakeTimers({ now: new Date("2026-11-03T09:00:30.000Z") });

      // Act
      history({ latest: latest({ updatedBy: "user", pptx: false }) });

      // Assert
      expect(screen.getByRole("button", { name: "Prepare .pptx" })).toBeTruthy();
      expect(screen.queryByText("The assistant is building this")).toBeNull();
    });
  });
});
