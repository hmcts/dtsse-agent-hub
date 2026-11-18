/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexEntry, LibraryStatus } from "@/assistant/docmosis-library";
import type { PodJobRequest, PodJobView } from "@/assistant/pod-jobs";
import { TEMPLATES } from "@/assistant/starters";
import type { ConversationView } from "@/assistant/views";
import { WAKING_RETRY_MS } from "@/components/assistant/AtlassianSearch";
import { type ChatActions, ChatView } from "@/components/assistant/ChatView";
import { ARRIVAL_TIMEOUT_MS, DocmosisPanel, RENDER_AFTER_MS, SharedDocmosis, useTemplateLoad } from "@/components/assistant/DocmosisPanel";
import type { DocmosisSummary, DocmosisView } from "@/components/assistant/docmosis-data";
import { TemplateLibrary } from "@/components/assistant/TemplateLibrary";
import { ANNOUNCE_AFTER_MS } from "@/components/live/Announcer";
import { instant } from "@/web/format";

vi.mock("@/components/assistant/docmosis-pdf", () => ({
  drawPdf: vi.fn(async () => [document.createElement("canvas")])
}));

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }), usePathname: () => "/assistant" }));

const hubHandlers = new Map<string, (data: unknown) => void>();
const jobListeners = new Set<(data: unknown) => void>();
vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: (type: string, handler: (data: unknown) => void) => hubHandlers.set(type, handler),
  useHubSubscribe: () => (listener: (data: unknown) => void) => {
    jobListeners.add(listener);
    return () => jobListeners.delete(listener);
  },
  useEndSession: () => () => undefined,
  useWatch: () => undefined
}));

const AGENT = "11111111-1111-1111-1111-111111111111";
const CONVERSATION = "22222222-2222-2222-2222-222222222222";
const VIEWER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const COMMIT = "c".repeat(40);
const KEY = "44444444-4444-4444-4444-444444444444";
const ENTRIES_URL = `/api/ui/assistant/docmosis-library/entries?commit=${COMMIT}&key=${KEY}`;
const JOB = "55555555-5555-5555-5555-555555555555";

const ENTRIES: IndexEntry[] = [
  ["Templates/AAT/Claim letter.docx", "1".repeat(40), 12_000],
  ["Templates/Base/Claim form.docx", "2".repeat(40), 48_000],
  ["Templates/Base/Defence.docx", "3".repeat(40), 20_000],
  ["Templates/Prod/Huge bundle.docx", "4".repeat(40), 6 * 1024 * 1024],
  ["Templates/Prod/Notice.docx", "5".repeat(40), 9_000]
];

function status(overrides: Partial<LibraryStatus> = {}): LibraryStatus {
  return {
    library: "hmcts/rdo-docmosis@HEAD:Templates",
    owner: "hmcts",
    repo: "rdo-docmosis",
    ref: "HEAD",
    path: "Templates",
    pod: "ok",
    commit: COMMIT,
    entry_count: ENTRIES.length,
    dropped: 0,
    entries_url: ENTRIES_URL,
    checked_at: "2026-11-18T09:00:00.000Z",
    refreshing: false,
    failure: null,
    ...overrides
  };
}

function view(overrides: Partial<DocmosisView> = {}): DocmosisView {
  return {
    version: 1,
    revision: 0,
    name: "Claim form.docx",
    docx: `sha256:${"a".repeat(64)}`,
    schema: { warnings: [], root: { kind: "object", controls: [], notes: [], properties: { claimant: { kind: "string", controls: [], notes: [] } } } },
    data: {},
    by: "user",
    summary: "Loaded Claim form.docx",
    updated_at: "2026-11-18T09:00:00.000Z",
    has_pdf: false,
    render_error: null,
    source_path: "Templates/Base/Claim form.docx",
    ...overrides
  };
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/**
 * A fetch that serves the library, its entries, pod jobs and the template. Each field is read at the time of the
 * call, so a test changes what the next call gets by setting it.
 */
function serve() {
  const server = {
    calls: [] as Call[],
    status: status() as LibraryStatus | null,
    libraryPost: null as Response | null,
    requests: [{ status: "pending", job_id: JOB }] as PodJobRequest[],
    job: { job_id: JOB, kind: "docmosis.load", status: "pending" } as PodJobView,
    view: view() as DocmosisView | null,
    renders: [] as unknown[],
    entriesFail: false
  };
  const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    server.calls.push({ url, method, body });
    if (url === "/api/ui/assistant/docmosis-library") {
      if (server.status === null) {
        return await new Promise<Response>(() => undefined);
      }
      if (method === "POST" && server.libraryPost !== null) {
        return server.libraryPost.clone();
      }
      return json(server.status);
    }
    if (url === ENTRIES_URL) {
      if (server.entriesFail) {
        return json({ error: "gone" }, { status: 500 });
      }
      return json({ commit: COMMIT, entries: ENTRIES });
    }
    if (url === `/api/ui/assistant/pod-jobs/${CONVERSATION}`) {
      const next = server.requests.length > 1 ? server.requests.shift() : server.requests[0];
      if (next !== undefined && "httpStatus" in next) {
        const refusal = next as unknown as { httpStatus: number; error: string };
        return json({ error: refusal.error }, { status: refusal.httpStatus });
      }
      return json(next);
    }
    if (url === `/api/ui/assistant/pod-jobs/${CONVERSATION}/${JOB}`) {
      return json(server.job);
    }
    if (url.endsWith("/render")) {
      server.renders.push(body);
      return json({ version: 1, revision: 1, status: "rendered" });
    }
    if (url.endsWith("/versions")) {
      return json({ versions: [] });
    }
    if (url.endsWith("/pdf")) {
      return new Response(new Uint8Array([37, 80, 68, 70]));
    }
    if (url === `/api/ui/assistant/docmosis/${CONVERSATION}`) {
      return server.view === null ? json({ error: "none" }, { status: 404 }) : json(server.view);
    }
    return json({ error: "not served" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return server;
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function emit(type: string, data: unknown = {}): void {
  act(() => {
    hubHandlers.get(type)?.(data);
  });
}

const options = () => screen.queryAllByRole("option").map((option) => option.textContent ?? "");
const box = () => screen.getByRole("combobox", { name: "Search templates" });
const liveStatus = () => screen.getAllByRole("status").map((region) => region.textContent ?? "");

async function openLibrary(props: Partial<React.ComponentProps<typeof TemplateLibrary>> = {}) {
  const onPick = vi.fn();
  const onCancel = vi.fn();
  const view = render(<TemplateLibrary onPick={onPick} onCancel={onCancel} {...props} />);
  await settle();
  return { onPick, onCancel, view };
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  });
});

afterEach(() => {
  cleanup();
  hubHandlers.clear();
  jobListeners.clear();
  refresh.mockReset();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TemplateLibrary search", () => {
  it("should open the library once, download its entries and filter them locally on every keystroke", async () => {
    const server = serve();
    await openLibrary();
    expect(server.calls.filter((call) => call.url === "/api/ui/assistant/docmosis-library")).toEqual([
      { url: "/api/ui/assistant/docmosis-library", method: "POST", body: {} }
    ]);
    expect(options()).toHaveLength(5);
    const before = server.calls.length;
    fireEvent.change(box(), { target: { value: "c" } });
    fireEvent.change(box(), { target: { value: "cl" } });
    fireEvent.change(box(), { target: { value: "claim" } });
    expect(options().map((text) => text.split(".docx")[0])).toEqual(["Claim form", "Claim letter"]);
    fireEvent.change(box(), { target: { value: "claim aat" } });
    expect(options()).toHaveLength(1);
    await settle(1000);
    expect(server.calls).toHaveLength(before);
  });

  it("should show each template's name, folder and size", async () => {
    serve();
    await openLibrary();
    fireEvent.change(box(), { target: { value: "defence" } });
    const option = screen.getByRole("option");
    expect(within(option).getByText("Defence.docx")).toBeTruthy();
    expect(within(option).getByText("Base")).toBeTruthy();
    expect(within(option).getByText("20 KB")).toBeTruthy();
  });

  it("should move the active option with the arrows, pick it with Enter and cancel on Escape", async () => {
    serve();
    const { onPick, onCancel } = await openLibrary();
    fireEvent.change(box(), { target: { value: "claim" } });
    const [first, second] = screen.getAllByRole("option");
    expect(box().getAttribute("aria-activedescendant")).toBe(first?.id);
    expect(first?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(box().getAttribute("aria-activedescendant")).toBe(second?.id);
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(box().getAttribute("aria-activedescendant")).toBe(first?.id);
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ path: "Templates/AAT/Claim letter.docx", blobSha: "1".repeat(40) }), { owner: "hmcts" });
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("should offer a chip for each folder and list only that folder's templates when one is pressed", async () => {
    serve();
    await openLibrary();
    const chips = within(screen.getByRole("group", { name: "Folders" }));
    expect(chips.getAllByRole("button").map((chip) => chip.textContent)).toEqual(["All folders", "AAT", "Base", "Prod"]);
    fireEvent.click(chips.getByRole("button", { name: "Prod, 2 templates" }));
    expect(chips.getByRole("button", { name: "Prod, 2 templates" }).getAttribute("aria-pressed")).toBe("true");
    expect(options().map((text) => text.split(".docx")[0])).toEqual(["Notice", "Huge bundle"]);
    fireEvent.click(chips.getByRole("button", { name: "All folders" }));
    expect(options()).toHaveLength(5);
  });

  it("should disable a template over 5 MiB and say it is too large to load", async () => {
    serve();
    const { onPick } = await openLibrary();
    fireEvent.change(box(), { target: { value: "huge" } });
    const option = screen.getByRole("option");
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(within(option).getByText("Too large to load")).toBeTruthy();
    fireEvent.click(option);
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("should pick a template that is clicked", async () => {
    serve();
    const { onPick } = await openLibrary();
    fireEvent.change(box(), { target: { value: "notice" } });
    fireEvent.click(screen.getByRole("option"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ path: "Templates/Prod/Notice.docx", name: "Notice.docx", folder: "Prod" }), {
      owner: "hmcts"
    });
  });

  it("should have no axe violations when the list is showing", async () => {
    serve();
    const { view } = await openLibrary();
    fireEvent.change(box(), { target: { value: "claim" } });
    vi.useRealTimers();
    const results = await axe.run(view.container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});

describe("TemplateLibrary status", () => {
  it("should say it is fetching the list while the first read is on its way", async () => {
    const server = serve();
    server.status = null;
    await openLibrary();
    expect(liveStatus()).toContain("Fetching the template list…");
  });

  it.each<[string, Partial<LibraryStatus>, string]>([
    ["no index has arrived yet", { commit: null, entries_url: null, entry_count: 0, refreshing: true }, "Fetching the template list for the first time"],
    ["the assistant is starting", { commit: null, entries_url: null, pod: "waking" }, "Your assistant is starting"],
    ["the assistant's client is too old", { pod: "unsupported" }, "Your assistant needs an update to read the template library"],
    ["GitHub is signed out", { failure: { reason: "signed_out" } }, "Sign in to GitHub in your assistant"],
    ["the sign-in needs single sign-on", { failure: { reason: "sso" } }, "needs single sign-on authorising for the hmcts organisation"],
    ["the account cannot see the repository", { failure: { reason: "not_found" } }, "no access to hmcts/rdo-docmosis"],
    ["a check is pending over an index", { refreshing: true }, "Showing the list from the last check while it is checked again"],
    ["the check failed in its own words", { failure: { reason: "failed", detail: "GitHub answered 500." } }, "GitHub answered 500."]
  ])("should say so when %s", async (_when, overrides, line) => {
    const server = serve();
    server.status = status(overrides);
    await openLibrary();
    expect(liveStatus().join(" ")).toContain(line);
  });

  it("should say until when GitHub's rate limit holds", async () => {
    const server = serve();
    server.status = status({ failure: { reason: "rate_limited", reset_at: "2026-11-18T10:30:00.000Z" } });
    await openLibrary();
    expect(liveStatus().join(" ")).toContain(`until ${instant("2026-11-18T10:30:00.000Z")}`);
  });

  it("should link to GitHub's single sign-on page when the failure gives one", async () => {
    const server = serve();
    server.status = status({ failure: { reason: "sso", sso_url: "https://github.com/orgs/hmcts/sso?authorization_request=1" } });
    await openLibrary();
    expect(screen.getByRole("link", { name: "Authorise single sign-on on GitHub" }).getAttribute("href")).toBe(
      "https://github.com/orgs/hmcts/sso?authorization_request=1"
    );
  });

  it("should say the list is incomplete when templates were dropped", async () => {
    const server = serve();
    server.status = status({ dropped: 3 });
    await openLibrary();
    expect(screen.getByText(/The list is incomplete: 3 templates were left out/)).toBeTruthy();
  });

  it("should open the library again while the assistant starts, and show the list once it has", async () => {
    const server = serve();
    server.status = status({ commit: null, entries_url: null, pod: "waking" });
    await openLibrary();
    const posts = () => server.calls.filter((call) => call.url === "/api/ui/assistant/docmosis-library" && call.method === "POST");
    expect(posts()).toHaveLength(1);
    server.status = status();
    await settle(WAKING_RETRY_MS);
    expect(posts()).toHaveLength(2);
    expect(options()).toHaveLength(5);
  });

  it("should read the library with GET when the hub says it has been checked, and when a check has gone unanswered", async () => {
    const server = serve();
    server.status = status({ refreshing: true });
    await openLibrary();
    const gets = () => server.calls.filter((call) => call.url === "/api/ui/assistant/docmosis-library" && call.method === "GET");
    server.status = status();
    emit("assistant_docmosis_library");
    await settle();
    expect(gets()).toHaveLength(1);
    server.status = status({ refreshing: true });
    emit("assistant_docmosis_library");
    await settle();
    await settle(2 * 60_000);
    expect(gets()).toHaveLength(3);
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("should force a check when Refresh is pressed, and say so when it was forced too recently", async () => {
    const server = serve();
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await settle();
    expect(server.calls.at(-1)).toEqual({ url: "/api/ui/assistant/docmosis-library", method: "POST", body: { force: true } });
    server.libraryPost = new Response(JSON.stringify({ error: "too soon" }), { status: 429 });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await settle();
    expect(liveStatus().join(" ")).toContain("The list was checked a moment ago");
  });

  it("should say why and keep the list when a Refresh fails after the list is showing", async () => {
    const server = serve();
    await openLibrary();
    server.libraryPost = new Response(JSON.stringify({ error: "The hub could not ask your assistant." }), { status: 502 });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await settle();
    expect(liveStatus().join(" ")).toContain("The hub could not ask your assistant.");
    expect(options()).toHaveLength(5);
  });

  it("should clear the download error when a later download succeeds", async () => {
    const server = serve();
    server.entriesFail = true;
    await openLibrary();
    expect(liveStatus().join(" ")).toContain("The template list could not be downloaded");
    server.entriesFail = false;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await settle();
    expect(liveStatus().join(" ")).not.toContain("could not be downloaded");
    expect(options()).toHaveLength(5);
  });

  it("should count every match while listing only the first page when more match than it shows", async () => {
    const many: IndexEntry[] = Array.from({ length: 60 }, (_, i) => [`Templates/Base/form ${i}.docx`, "6".repeat(40), 1_000]);
    serve();
    vi.mocked(fetch).mockImplementation(async (url) =>
      url === ENTRIES_URL ? new Response(JSON.stringify({ commit: COMMIT, entries: many })) : new Response(JSON.stringify(status()))
    );
    await openLibrary();
    expect(options()).toHaveLength(50);
    expect(liveStatus().join(" ")).toContain("60 templates match; showing the first 50.");
  });
});

const SUMMARY: DocmosisSummary = { name: "Claim form.docx", version: 1, revision: 0, updatedBy: "user", pdf: "pending" };

/** The panel with a loader of its own, as the chat gives it; rerendering with new props keeps the loader's state. */
function Panel({ library = true, ...props }: Partial<React.ComponentProps<typeof DocmosisPanel>> & { library?: boolean }) {
  const docmosis = props.docmosis ?? null;
  const announce = props.announce ?? (() => undefined);
  const loader = useTemplateLoad({ conversationId: CONVERSATION, docmosis, announce });
  return (
    <DocmosisPanel
      conversationId={CONVERSATION}
      owner
      onClose={() => undefined}
      narrow={false}
      {...props}
      docmosis={docmosis}
      announce={announce}
      loader={library ? loader : undefined}
    />
  );
}

async function pickClaimForm(): Promise<void> {
  fireEvent.change(box(), { target: { value: "claim form" } });
  fireEvent.keyDown(box(), { key: "Enter" });
  await settle();
}

const loadRequests = (server: ReturnType<typeof serve>) => server.calls.filter((call) => call.url === `/api/ui/assistant/pod-jobs/${CONVERSATION}`);

describe("DocmosisPanel choosing a template", () => {
  it("should open on the library under Choose a template, and read no template, when the chat has none", async () => {
    const server = serve();
    render(<Panel />);
    await settle();
    expect(screen.getByRole("heading", { name: "Choose a template" })).toBeTruthy();
    expect(box()).toBeTruthy();
    expect(server.calls.some((call) => call.url.startsWith("/api/ui/assistant/docmosis/"))).toBe(false);
  });

  it("should offer no lookup to a reader, or on a chat with no pod", async () => {
    serve();
    const { rerender } = render(<Panel owner={false} />);
    await settle();
    expect(screen.getByText("There is no template in this chat yet.")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Search templates" })).toBeNull();
    rerender(<Panel docmosis={SUMMARY} library={false} />);
    await settle();
    expect(screen.queryByRole("button", { name: "Change template" })).toBeNull();
  });

  it("should never offer Change template on a shared chat", async () => {
    serve();
    render(<SharedDocmosis conversationId={CONVERSATION} docmosis={SUMMARY} />);
    await settle();
    expect(screen.queryByRole("button", { name: "Change template" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Search templates" })).toBeNull();
  });

  it("should load the picked template on the base shown, say so, and render its first PDF exactly once when it arrives", async () => {
    const server = serve();
    const announce = vi.fn();
    const { rerender } = render(<Panel announce={announce} />);
    await settle();
    await pickClaimForm();
    expect(loadRequests(server).map((call) => call.body)).toEqual([
      { kind: "docmosis.load", args: { path: "Templates/Base/Claim form.docx", blob_sha: "2".repeat(40), base_version: 0, base_revision: 0 } }
    ]);
    expect(liveStatus().join(" ")).toContain("Loading Claim form.docx…");
    server.job = { job_id: JOB, kind: "docmosis.load", status: "done", result: { version: 1, revision: 0 } };
    act(() => {
      for (const listener of jobListeners) {
        listener({ job_id: JOB, conversation_id: CONVERSATION });
      }
    });
    await settle();
    expect(liveStatus().join(" ")).toContain("Loading Claim form.docx…");
    rerender(<Panel announce={announce} docmosis={SUMMARY} />);
    await settle();
    expect(announce).toHaveBeenCalledWith("Loaded Claim form.docx");
    expect(screen.getByRole("heading", { name: "Claim form.docx" })).toBeTruthy();
    expect(server.renders).toEqual([{ data: {}, base_version: 1, base_revision: 0 }]);
    server.view = view({ revision: 1, has_pdf: true });
    rerender(<Panel announce={announce} docmosis={{ ...SUMMARY, revision: 1, pdf: "ready" }} />);
    await settle(RENDER_AFTER_MS * 2);
    expect(server.renders).toHaveLength(1);
  });

  it("should not render a version the assistant wrote, or one the person edited, as a first render", async () => {
    const server = serve();
    server.view = view({ by: "agent", summary: "First draft" });
    const { unmount } = render(<Panel docmosis={{ ...SUMMARY, updatedBy: "agent" }} />);
    await settle(RENDER_AFTER_MS * 2);
    unmount();
    server.view = view({ summary: "Edited form data", source_path: null });
    render(<Panel docmosis={SUMMARY} />);
    await settle(RENDER_AFTER_MS * 2);
    expect(server.renders).toEqual([]);
  });

  it("should ask the load again while the assistant starts, and say what it waits for", async () => {
    const server = serve();
    server.requests = [{ status: "waking" }, { status: "pending", job_id: JOB }];
    render(<Panel />);
    await settle();
    await pickClaimForm();
    expect(liveStatus().join(" ")).toContain("Your assistant is starting, so it can load Claim form.docx");
    await settle(WAKING_RETRY_MS);
    expect(loadRequests(server)).toHaveLength(2);
    expect(liveStatus().join(" ")).toContain("Loading Claim form.docx…");
  });

  it("should offer the person's load or the assistant's version when the assistant wrote one while it loaded", async () => {
    const server = serve();
    server.job = { job_id: JOB, kind: "docmosis.load", status: "failed", error: "conflict" };
    server.view = view({ version: 4, revision: 2, by: "agent", summary: "Newer", has_pdf: true });
    const { rerender } = render(<Panel />);
    await settle();
    await pickClaimForm();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("The assistant wrote version 4 while yours was loading.");
    server.job = { job_id: JOB, kind: "docmosis.load", status: "pending" };
    fireEvent.click(within(alert).getByRole("button", { name: "Load mine anyway" }));
    await settle();
    expect(loadRequests(server).at(-1)?.body).toEqual({
      kind: "docmosis.load",
      args: { path: "Templates/Base/Claim form.docx", blob_sha: "2".repeat(40), base_version: 4, base_revision: 2 }
    });

    server.job = { job_id: JOB, kind: "docmosis.load", status: "failed", error: "conflict" };
    await settle(2000);
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Keep theirs" }));
    rerender(<Panel docmosis={{ name: "Newer.docx", version: 4, revision: 2, updatedBy: "agent", pdf: "ready" }} />);
    await settle();
    expect(screen.queryByRole("combobox", { name: "Search templates" })).toBeNull();
    expect(screen.getByRole("button", { name: "Change template" })).toBeTruthy();
    expect(server.renders).toEqual([]);
  });

  it.each<[string, PodJobView | { httpStatus: number; error: string }, string]>([
    [
      "signed out",
      { job_id: JOB, kind: "docmosis.load", status: "failed", error: "signed_out" },
      "Sign in to GitHub in your assistant, then pick the template again."
    ],
    ["not authorised for SSO", { job_id: JOB, kind: "docmosis.load", status: "failed", error: "sso" }, "single sign-on"],
    ["not found", { job_id: JOB, kind: "docmosis.load", status: "failed", error: "not_found" }, "GitHub could not find that template"],
    ["rate limited", { job_id: JOB, kind: "docmosis.load", status: "failed", error: "rate_limited" }, "GitHub's rate limit has been reached."],
    [
      "too large",
      { job_id: JOB, kind: "docmosis.load", status: "failed", error: "too_large" },
      "That template is larger than 5.0 MB, more than the Assistant can open."
    ],
    ["not a docx", { job_id: JOB, kind: "docmosis.load", status: "failed", error: "not_docx" }, "not a Word document"],
    ["a checksum mismatch", { job_id: JOB, kind: "docmosis.load", status: "failed", error: "checksum" }, "did not match the template list"],
    [
      "a schema failure",
      { job_id: JOB, kind: "docmosis.load", status: "failed", error: "schema_failed", detail: "no form fields" },
      "The template's form could not be read: no form fields"
    ],
    ["timed out", { job_id: JOB, kind: "docmosis.load", status: "timeout" }, "did not load the template in time"],
    ["any other failure", { job_id: JOB, kind: "docmosis.load", status: "failed", error: "failed", detail: "the disk is full" }, "The disk is full."],
    [
      "too large for the hub",
      { httpStatus: 413, error: "that template is larger than 5242880 bytes" },
      "That template is larger than 5.0 MB, more than the Assistant can open."
    ]
  ])("should say so in one sentence when the load is %s", async (_when, answer, sentence) => {
    const server = serve();
    if ("httpStatus" in answer) {
      server.requests = [answer as unknown as PodJobRequest];
    } else {
      server.job = answer;
    }
    render(<Panel />);
    await settle();
    await pickClaimForm();
    expect(screen.getByRole("alert").textContent).toContain(sentence);
  });

  it("should read the library again when the hub says the list has changed", async () => {
    const server = serve();
    server.requests = [{ httpStatus: 409, error: "the template list has changed; pick again" } as unknown as PodJobRequest];
    render(<Panel />);
    await settle();
    await pickClaimForm();
    expect(screen.getByRole("alert").textContent).toBe("The template list has changed; pick again.");
    expect(server.calls.filter((call) => call.url === "/api/ui/assistant/docmosis-library" && call.method === "GET")).toHaveLength(1);
  });
});

function finishJob(server: ReturnType<typeof serve>, job: PodJobView): void {
  server.job = job;
  act(() => {
    for (const listener of jobListeners) {
      listener({ job_id: JOB, conversation_id: CONVERSATION });
    }
  });
}

const DONE: PodJobView = { job_id: JOB, kind: "docmosis.load", status: "done", result: { version: 1, revision: 0 } };
const CONFLICT: PodJobView = { job_id: JOB, kind: "docmosis.load", status: "failed", error: "conflict" };

describe("DocmosisPanel while a load runs", () => {
  it("should keep the load and its conflict on screen when the assistant writes the chat's first template mid-load", async () => {
    const server = serve();
    const { rerender } = render(<Panel />);
    await settle();
    await pickClaimForm();
    rerender(<Panel docmosis={{ ...SUMMARY, name: "Draft.docx", updatedBy: "agent" }} />);
    await settle();
    expect(screen.getByRole("heading", { name: "Choose a template" })).toBeTruthy();
    expect(liveStatus().join(" ")).toContain("Loading Claim form.docx…");
    server.view = view({ name: "Draft.docx", by: "agent", summary: "Draft", source_path: null });
    finishJob(server, CONFLICT);
    await settle();
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "Load mine anyway" })).toBeTruthy();
  });

  it("should offer no Back, say what the load replaces, and close on Escape when a load is pending", async () => {
    serve();
    const onClose = vi.fn();
    render(<Panel docmosis={SUMMARY} onClose={onClose} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Change template" }));
    await settle();
    expect(screen.getByRole("button", { name: "Back to template" })).toBeTruthy();
    fireEvent.change(box(), { target: { value: "notice" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    await settle();
    expect(screen.queryByRole("button", { name: "Back to template" })).toBeNull();
    expect(liveStatus().join(" ")).toContain("Loading Notice.docx… It replaces Claim form.docx when it arrives.");
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Choose a template" })).toBeTruthy();
  });

  it("should go back to the assistant's version and say it was kept, not loaded, when Keep theirs is pressed", async () => {
    const server = serve();
    server.job = CONFLICT;
    server.view = view({ version: 4, revision: 2, name: "Newer.docx", by: "agent", summary: "Newer", has_pdf: true, source_path: null });
    const announce = vi.fn();
    render(<Panel announce={announce} />);
    await settle();
    await pickClaimForm();
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Keep theirs" }));
    await settle();
    expect(announce).toHaveBeenLastCalledWith("Kept the assistant's version");
    expect(announce).not.toHaveBeenCalledWith(expect.stringMatching(/^Loaded/));
    expect(screen.getByRole("heading", { name: "Newer.docx" })).toBeTruthy();
    expect(server.renders).toEqual([]);
  });

  it("should read the template itself and stop waiting when the summary has not arrived in time", async () => {
    const server = serve();
    const announce = vi.fn();
    render(<Panel announce={announce} />);
    await settle();
    await pickClaimForm();
    finishJob(server, DONE);
    await settle();
    expect(liveStatus().join(" ")).toContain("Loading Claim form.docx…");
    await settle(ARRIVAL_TIMEOUT_MS);
    await settle();
    expect(announce).toHaveBeenCalledWith("Loaded Claim form.docx");
    expect(screen.getByRole("heading", { name: "Claim form.docx" })).toBeTruthy();
    expect(server.renders).toEqual([{ data: {}, base_version: 1, base_revision: 0 }]);
  });

  it("should say so and let another template be picked when the summary has not arrived in time and the template cannot be read", async () => {
    const server = serve();
    render(<Panel />);
    await settle();
    await pickClaimForm();
    server.view = null;
    finishJob(server, DONE);
    await settle();
    await settle(ARRIVAL_TIMEOUT_MS);
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("Claim form.docx was loaded, but it could not be shown.");
    fireEvent.change(box(), { target: { value: "notice" } });
    expect(screen.getByRole("option").getAttribute("aria-disabled")).toBeNull();
  });

  it("should name the library's own GitHub owner when the sign-in needs its single sign-on", async () => {
    const server = serve();
    server.status = status({ owner: "acme" });
    server.job = { job_id: JOB, kind: "docmosis.load", status: "failed", error: "sso" };
    render(<Panel />);
    await settle();
    await pickClaimForm();
    expect(screen.getByRole("alert").textContent).toBe("Your GitHub sign-in is not authorised for the acme organisation's single sign-on.");
  });

  it("should render a loaded version first whatever its summary says when it came from a library path", async () => {
    const server = serve();
    server.view = view({ summary: "Whatever the pod said" });
    render(<Panel docmosis={SUMMARY} />);
    await settle();
    expect(server.renders).toEqual([{ data: {}, base_version: 1, base_revision: 0 }]);
  });
});

describe("DocmosisPanel Change template", () => {
  it("should swap the form for the library, and go back to the template on request", async () => {
    serve();
    render(<Panel docmosis={SUMMARY} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Change template" }));
    await settle();
    expect(screen.getByRole("heading", { name: "Choose a template" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to template" }));
    expect(screen.getByRole("heading", { name: "Claim form.docx" })).toBeTruthy();
  });

  it("should load the new template on the version shown", async () => {
    const server = serve();
    server.view = view({ has_pdf: true });
    render(<Panel docmosis={{ ...SUMMARY, version: 3, revision: 1 }} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Change template" }));
    await settle();
    await pickClaimForm();
    expect(loadRequests(server)[0]?.body).toEqual(expect.objectContaining({ args: expect.objectContaining({ base_version: 3, base_revision: 1 }) }));
  });

  it("should ask first, and stay on the form, while edits are not yet rendered", async () => {
    const server = serve();
    server.view = view({ has_pdf: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Panel docmosis={SUMMARY} />);
    await settle();
    fireEvent.change(screen.getByLabelText(/^claimant/), { target: { value: "Ann" } });
    fireEvent.click(screen.getByRole("button", { name: "Change template" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Change the template anyway"));
    expect(screen.queryByRole("combobox", { name: "Search templates" })).toBeNull();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Change template" }));
    await settle();
    expect(box()).toBeTruthy();
  });
});

function conversation(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    id: CONVERSATION,
    title: "Writing a letter",
    product: "ccd",
    productLabel: "CCD",
    pinned: false,
    productHistory: [],
    stopHistory: [],
    local: false,
    agentId: AGENT,
    agentStatus: "idle",
    repoBase: null,
    skills: [],
    clientFeatures: null,
    sessionState: null,
    sessionDetail: null,
    artefact: { title: null, markdown: "", version: 0, updatedBy: null, updatedAt: null },
    deck: null,
    docmosis: null,
    notify: null,
    video: null,
    canPostVideo: false,
    jira: { status: "none" },
    github: { status: "none" },
    confluence: { status: "none" },
    page: { messages: [], entries: [], olderBefore: null, lastId: null, more: false },
    forked: null,
    questions: [],
    ...overrides
  };
}

function actions(): ChatActions {
  const ok = vi.fn(async () => ({ ok: true as const }));
  return {
    send: vi.fn(),
    warm: ok,
    stop: vi.fn(async () => ({ ok: true as const, stopped: true })),
    setProduct: ok,
    rename: ok,
    pin: ok,
    remove: ok,
    answerQuestion: ok,
    saveArtefact: vi.fn(),
    exportToJira: ok
  } as unknown as ChatActions;
}

function Chat({ view: shown }: { view: ConversationView }) {
  return <ChatView jira={{ connected: false, login: null }} viewerOid={VIEWER} view={shown} templates={TEMPLATES} actions={actions()} />;
}

/** Chooses Docmosis template from the header's Create menu. */
function createTemplate(): void {
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Docmosis template/ }));
}

describe("ChatView template button", () => {
  it("should open the library when the person creates a Docmosis template on a pod chat with none", async () => {
    serve();
    render(<Chat view={conversation()} />);
    createTemplate();
    await settle();
    expect(screen.getByRole("heading", { name: "Choose a template" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Items, Docmosis template open" })).toBeTruthy();
  });

  it("should offer the template in the switcher, and Create should open it, when the chat has a template", () => {
    serve();
    render(<Chat view={conversation({ docmosis: SUMMARY })} />);
    fireEvent.click(screen.getByRole("button", { name: /^Items/ }));
    expect(screen.getByRole("menuitemradio", { name: "Docmosis template" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("menuitem", { name: "Docmosis template, already in this chat" })).toBeTruthy();
  });

  it("should offer no Docmosis template when a local chat has none", () => {
    serve();
    render(<Chat view={conversation({ local: true })} />);
    expect(screen.queryByRole("button", { name: /^Items/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.queryByRole("menuitem", { name: /^Docmosis template/ })).toBeNull();
  });

  it("should not open the panel for a version the person loaded, and should for one the assistant wrote", async () => {
    serve();
    const { rerender } = render(<Chat view={conversation()} />);
    rerender(<Chat view={conversation({ docmosis: SUMMARY })} />);
    await settle();
    expect(screen.queryByRole("region", { name: "Template" })).toBeNull();
    rerender(<Chat view={conversation({ docmosis: { ...SUMMARY, version: 2, updatedBy: "agent" } })} />);
    await settle();
    expect(screen.getByRole("region", { name: "Template" })).toBeTruthy();
  });

  it("should keep a load running when the panel is closed, and open on the loaded template when it lands", async () => {
    const server = serve();
    const { rerender } = render(<Chat view={conversation()} />);
    createTemplate();
    await settle();
    await pickClaimForm();
    fireEvent.click(screen.getByRole("button", { name: "Close template" }));
    expect(screen.queryByRole("region", { name: "Template" })).toBeNull();
    finishJob(server, DONE);
    await settle();
    rerender(<Chat view={conversation({ docmosis: SUMMARY })} />);
    await settle();
    expect(screen.getByRole("heading", { name: "Claim form.docx" })).toBeTruthy();
    await settle(ANNOUNCE_AFTER_MS);
    expect(screen.getAllByTestId("arrivals").map((region) => region.textContent)).toContain("Loaded Claim form.docx");
  });

  it("should keep the template in the switcher, marked once the load fails, when another panel opens on a chat with no template", async () => {
    const server = serve();
    render(<Chat view={conversation()} />);
    createTemplate();
    await settle();
    await pickClaimForm();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Document" }));
    fireEvent.click(screen.getByRole("button", { name: /^Items/ }));
    expect(screen.getByRole("menuitemradio", { name: "Docmosis template" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Items/ }));

    finishJob(server, { job_id: JOB, kind: "docmosis.load", status: "failed", error: "not_docx" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Document" }));
    fireEvent.click(screen.getByRole("button", { name: /^Items/ }));
    expect(screen.getByRole("menuitemradio", { name: "Docmosis template, which did not load" })).toBeTruthy();
    expect(screen.getByTestId("docmosis-failed")).toBeTruthy();
  });

  it("should open on the conflict choice when a load the panel was closed on is refused for a newer version", async () => {
    const server = serve();
    render(<Chat view={conversation()} />);
    createTemplate();
    await settle();
    await pickClaimForm();
    fireEvent.click(screen.getByRole("button", { name: "Close template" }));
    server.view = view({ version: 2, by: "agent", summary: "Newer", source_path: null });
    finishJob(server, CONFLICT);
    await settle();
    expect(within(screen.getByRole("region", { name: "Template" })).getByRole("button", { name: "Load mine anyway" })).toBeTruthy();
  });
});
