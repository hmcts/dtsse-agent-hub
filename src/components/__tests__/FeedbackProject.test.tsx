/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { projectTab } from "@/components/feedback/dev/look";
import { ProjectList } from "@/components/feedback/dev/ProjectList";
import { type ProjectActions, ProjectPage } from "@/components/feedback/dev/ProjectPage";
import { pageData, project, recordingRow, thread } from "./feedback-fixtures";

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }), usePathname: () => "/assistant/feedback/p1" }));

const hubHandlers = new Map<string, (data: unknown) => void>();
vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: (type: string, handler: (data: unknown) => void) => hubHandlers.set(type, handler),
  useEndSession: () => () => undefined
}));

vi.mock("@rrweb/replay", () => ({ Replayer: vi.fn() }));

type MockedActions = { [K in keyof ProjectActions]: ProjectActions[K] & Mock };

function actions(): MockedActions {
  return {
    addLink: vi.fn().mockResolvedValue({ ok: true, link: {} }),
    revokeLink: vi.fn().mockResolvedValue({ ok: true }),
    rotateLink: vi.fn().mockResolvedValue({ ok: true, link: {} }),
    setMembers: vi.fn().mockResolvedValue({ ok: true, members: [] }),
    updateSettings: vi.fn().mockResolvedValue({ ok: true, project: project() }),
    archive: vi.fn().mockResolvedValue({ ok: true }),
    reply: vi.fn().mockResolvedValue({ ok: true, comment: {} }),
    setStatus: vi.fn().mockResolvedValue({ ok: true, thread: {} }),
    probe: vi.fn().mockResolvedValue({ ok: true, probe: { result: "pass", status: 200, reason: "it answered 200" } })
  } as unknown as MockedActions;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 404 }))
  );
});

afterEach(() => {
  cleanup();
  refresh.mockReset();
  push.mockReset();
  hubHandlers.clear();
  vi.unstubAllGlobals();
});

function tabs(): string[] {
  return within(screen.getByRole("navigation", { name: "Project sections" }))
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

describe("projectTab", () => {
  it("should open the tab the address names, and the overview for anything else", () => {
    expect(projectTab("comments", false)).toBe("comments");
    expect(projectTab(["comments"], false)).toBe("overview");
    expect(projectTab("nonsense", true)).toBe("overview");
  });

  it("should open settings for the owner alone", () => {
    expect(projectTab("settings", true)).toBe("settings");
    expect(projectTab("settings", false)).toBe("overview");
  });
});

describe("ProjectPage", () => {
  it("should show the owner every tab, with the open one marked and each in the address", () => {
    render(<ProjectPage data={pageData()} tab="recordings" actions={actions()} origin="https://hub.example.com" />);

    expect(tabs()).toEqual(["Overview", "Comments", "Recordings", "People", "Settings"]);
    expect(screen.getByRole("link", { name: "Recordings" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "People" }).getAttribute("href")).toBe("/assistant/feedback/p1?tab=people");
  });

  it("should not offer settings, or a way to change the links, to a member of the team", () => {
    render(<ProjectPage data={pageData({ project: project({ access: "member" }) })} tab="overview" actions={actions()} origin="https://hub.example.com" />);

    expect(tabs()).not.toContain("Settings");
    expect(screen.queryByRole("button", { name: /New share link/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy Share link for Round 1" })).toBeTruthy();
  });

  it("should not render settings for a member even when asked for them", () => {
    render(<ProjectPage data={pageData({ project: project({ access: "member" }) })} tab="settings" actions={actions()} origin="https://hub.example.com" />);

    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
  });

  it("should count the threads, recordings and reviewers on the overview, with the latest activity", () => {
    render(<ProjectPage data={pageData()} tab="overview" actions={actions()} origin="https://hub.example.com" />);

    const figures = Object.fromEntries(screen.getAllByRole("term").map((term) => [term.textContent, term.nextElementSibling?.textContent]));
    expect(figures).toEqual({ "Open comments": "1", Resolved: "1", "Not found on the page": "0", Recordings: "1", Reviewers: "2" });
    expect(screen.getByText(/recorded 3m 05s/)).toBeTruthy();
    expect((screen.getByLabelText("Share link for Round 1") as HTMLInputElement).value).toBe("https://hub.example.com/review/tok-one");
  });

  it("should say so when nothing has happened yet", () => {
    render(<ProjectPage data={pageData({ threads: [], recordings: [] })} tab="overview" actions={actions()} origin="https://hub.example.com" />);

    expect(screen.getByText(/Nothing yet/)).toBeTruthy();
  });

  it("should give a link a new token or turn it off for the owner, and refresh the page", async () => {
    const act$ = actions();
    render(<ProjectPage data={pageData()} tab="overview" actions={act$} origin="https://hub.example.com" />);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "New share link for Round 1" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Turn off Round 1" })));

    expect(act$.rotateLink).toHaveBeenCalledWith({ projectId: "p1", linkId: "l1" });
    expect(act$.revokeLink).toHaveBeenCalledWith({ projectId: "p1", linkId: "l1" });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("should say why a link could not be changed", async () => {
    const act$ = actions();
    act$.rotateLink.mockResolvedValue({ ok: false, error: "that link is turned off; add a new one instead" });
    render(<ProjectPage data={pageData()} tab="overview" actions={act$} origin="https://hub.example.com" />);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "New share link for Round 1" })));

    expect(screen.getByRole("alert").textContent).toBe("that link is turned off; add a new one instead");
  });

  it("should show a link that is turned off without its share address", () => {
    const links = [{ ...project().links[0]!, revokedAt: "2026-11-02T00:00:00.000Z" }];
    render(<ProjectPage data={pageData({ project: project({ links }) })} tab="overview" actions={actions()} origin="https://hub.example.com" />);

    expect(screen.getByText("turned off")).toBeTruthy();
    expect(screen.queryByLabelText("Share link for Round 1")).toBeNull();
  });

  it("should say an archived project's links have stopped, and offer no changes", () => {
    render(
      <ProjectPage
        data={pageData({ project: project({ archivedAt: "2026-11-12T00:00:00.000Z" }) })}
        tab="settings"
        actions={actions()}
        origin="https://hub.example.com"
      />
    );

    expect(screen.getByRole("note").textContent).toContain("archived");
    expect(screen.queryByRole("button", { name: "Archive project" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Turn off/ })).toBeNull();
  });

  it("should list recordings with who, where, how long and what they visited, linking the playable ones", () => {
    const recordings = [recordingRow("r1"), recordingRow("r2", { status: "recording", durationMs: null, pages: [], comments: 0 })];
    render(<ProjectPage data={pageData({ recordings })} tab="recordings" actions={actions()} origin="https://hub.example.com" />);

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByRole("link").getAttribute("href")).toBe("/assistant/feedback/p1/recordings/r1");
    expect(rows[0]!.textContent).toContain("3m 05s");
    expect(rows[0]!.textContent).toContain("/start, /details");
    expect(within(rows[1]!).queryByRole("link")).toBeNull();
    expect(rows[1]!.textContent).toContain("still recording");
  });

  it("should say when there are no recordings", () => {
    render(<ProjectPage data={pageData({ recordings: [] })} tab="recordings" actions={actions()} origin="https://hub.example.com" />);

    expect(screen.getByText(/No recordings yet/)).toBeTruthy();
  });

  it("should show the team and reviewers, and one reviewer's comments and recordings in order when chosen", () => {
    render(<ProjectPage data={pageData()} tab="people" actions={actions()} origin="https://hub.example.com" />);

    expect(screen.getByText("Olive Owner")).toBeTruthy();
    expect(screen.getAllByText("Mo Member").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Ben Reviewer/ }));

    const by = screen.getByRole("heading", { name: "By Ben Reviewer" }).parentElement as HTMLElement;
    expect(
      within(by)
        .getAllByRole("listitem")
        .map((item) => (item.textContent?.includes("Recording") ? "recording" : "thread"))
    ).toEqual(["thread", "recording"]);
    expect(within(by).getByRole("link", { name: "Play" }).getAttribute("href")).toBe("/assistant/feedback/p1/recordings/r1");
  });

  it("should say when nobody has reviewed yet", () => {
    render(<ProjectPage data={pageData({ threads: [], recordings: [] })} tab="people" actions={actions()} origin="https://hub.example.com" />);

    expect(screen.getByText(/Nobody has commented or recorded yet/)).toBeTruthy();
  });

  it("should save the owner's change to the team", async () => {
    const act$ = actions();
    render(<ProjectPage data={pageData()} tab="people" actions={act$} origin="https://hub.example.com" />);

    expect(screen.getByRole("button", { name: "Save team" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove Mo Member" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save team" })));

    expect(act$.setMembers).toHaveBeenCalledWith({ projectId: "p1", memberOids: [] });
    expect(screen.getByRole("status").textContent).toBe("The team is saved.");
  });

  it("should say why the team could not be saved", async () => {
    const act$ = actions();
    act$.setMembers.mockResolvedValue({ ok: false, error: "someone named has not used the hub yet, so cannot be added" });
    render(<ProjectPage data={pageData()} tab="people" actions={act$} origin="https://hub.example.com" />);

    fireEvent.click(screen.getByRole("button", { name: "Remove Mo Member" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save team" })));

    expect(screen.getByRole("alert").textContent).toBe("someone named has not used the hub yet, so cannot be added");
  });

  it("should save the owner's settings", async () => {
    const act$ = actions();
    render(<ProjectPage data={pageData()} tab="settings" actions={act$} origin="https://hub.example.com" />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Renamed " } });
    fireEvent.click(screen.getByLabelText(/Hide what reviewers type/));
    fireEvent.change(screen.getByLabelText(/Keep comments/), { target: { value: "14" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save settings" })));

    expect(act$.updateSettings).toHaveBeenCalledWith({ projectId: "p1", settings: { name: "Renamed", mask_inputs: true, retention_days: 14 } });
    expect(screen.getByText("Settings saved.")).toBeTruthy();
  });

  it("should add a link after checking it, and refuse one the hub will not allow", async () => {
    const act$ = actions();
    render(<ProjectPage data={pageData()} tab="settings" actions={act$} origin="https://hub.example.com" />);
    const form = screen.getByRole("heading", { name: "Add a link" }).parentElement as HTMLElement;

    await act(async () => fireEvent.click(within(form).getByRole("button", { name: "Add link" })));
    expect(within(form).getByRole("alert").textContent).toContain("Give the link a label");

    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "Round 2" } });
    fireEvent.change(within(form).getByLabelText("Prototype address"), { target: { value: "https://proto2.example.com" } });
    fireEvent.change(within(form).getByLabelText("Prototype version (optional)"), { target: { value: "v9" } });
    await act(async () => fireEvent.click(within(form).getByRole("button", { name: "Add link" })));
    expect(act$.addLink).toHaveBeenCalledWith({ projectId: "p1", link: { label: "Round 2", url: "https://proto2.example.com", prototype_version: "v9" } });
    expect(within(form).getByRole("status").textContent).toBe("Link added.");

    act$.probe.mockResolvedValue({ ok: true, probe: { result: "warn", status: 503, reason: "it answered 503, so check the address" } });
    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "Round 3" } });
    fireEvent.change(within(form).getByLabelText("Prototype address"), { target: { value: "https://proto3.example.com" } });
    await act(async () => fireEvent.click(within(form).getByRole("button", { name: "Add link" })));
    expect(within(form).getByRole("status").textContent).toContain("could not be confirmed");

    act$.probe.mockResolvedValue({ ok: true, probe: { result: "refused", reason: "the address must be on the public internet" } });
    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "Inside" } });
    fireEvent.change(within(form).getByLabelText("Prototype address"), { target: { value: "https://intranet.example.com" } });
    await act(async () => fireEvent.click(within(form).getByRole("button", { name: "Add link" })));
    expect(within(form).getByRole("alert").textContent).toContain("cannot be used");
    expect(act$.addLink).toHaveBeenCalledTimes(2);

    act$.probe.mockResolvedValue({ ok: true, probe: { result: "pass", status: 200, reason: "ok" } });
    act$.addLink.mockResolvedValue({ ok: false, error: "a project holds at most 20 links" });
    await act(async () => fireEvent.click(within(form).getByRole("button", { name: "Add link" })));
    expect(within(form).getByRole("alert").textContent).toBe("a project holds at most 20 links");
  });

  it("should add an http link only when the hub allows private targets", async () => {
    const act$ = actions();
    const { rerender } = render(<ProjectPage data={pageData()} tab="settings" actions={act$} origin="https://hub.example.com" />);
    const form = () => screen.getByRole("heading", { name: "Add a link" }).parentElement as HTMLElement;
    fireEvent.change(within(form()).getByLabelText("Label"), { target: { value: "Local" } });
    fireEvent.change(within(form()).getByLabelText("Prototype address"), { target: { value: "http://localhost:4100/" } });
    await act(async () => fireEvent.click(within(form()).getByRole("button", { name: "Add link" })));
    expect(act$.probe).not.toHaveBeenCalled();

    rerender(<ProjectPage data={pageData()} tab="settings" actions={act$} origin="https://hub.example.com" allowHttp />);
    await act(async () => fireEvent.click(within(form()).getByRole("button", { name: "Add link" })));
    expect(act$.addLink).toHaveBeenCalledWith({ projectId: "p1", link: { label: "Local", url: "http://localhost:4100/" } });
  });

  it("should archive only once the owner confirms, and go back to the list", async () => {
    const act$ = actions();
    render(<ProjectPage data={pageData()} tab="settings" actions={act$} origin="https://hub.example.com" />);

    fireEvent.click(screen.getByRole("button", { name: "Archive project" }));
    const dialog = screen.getByRole("alertdialog", { name: "Archive Apply for a thing?" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(act$.archive).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Archive project" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Archive" })));

    expect(act$.archive).toHaveBeenCalledWith({ projectId: "p1" });
    expect(push).toHaveBeenCalledWith("/assistant/feedback");
  });

  it("should say why archiving was refused", async () => {
    const act$ = actions();
    act$.archive.mockResolvedValue({ ok: false, error: "only the project's owner can change it" });
    render(<ProjectPage data={pageData()} tab="settings" actions={act$} origin="https://hub.example.com" />);

    fireEvent.click(screen.getByRole("button", { name: "Archive project" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Archive" })));

    expect(push).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alert").some((alert) => alert.textContent === "only the project's owner can change it")).toBe(true);
  });

  it("should reply to and resolve a thread on the comments tab, refreshing once each is saved", async () => {
    const act$ = actions();
    render(<ProjectPage data={pageData({ threads: [thread("t1")] })} tab="comments" actions={act$} origin="https://hub.example.com" />);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Resolve" })));
    expect(act$.setStatus).toHaveBeenCalledWith({ projectId: "p1", threadId: "t1", status: "resolved" });
    expect(refresh).toHaveBeenCalledTimes(1);

    act$.setStatus.mockResolvedValue({ ok: false, error: "that project is archived" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Resolve" })));
    expect(screen.getByRole("alert").textContent).toBe("that project is archived");
  });

  it("should send a reply through the reply action", async () => {
    const act$ = actions();
    render(<ProjectPage data={pageData({ threads: [thread("t1")] })} tab="comments" actions={act$} origin="https://hub.example.com" />);

    fireEvent.change(screen.getByRole("combobox", { name: /Reply to/ }), { target: { value: "Thanks" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reply" })));

    expect(act$.reply).toHaveBeenCalledWith({ projectId: "p1", threadId: "t1", body: "Thanks" });
    act$.reply.mockRejectedValue(new TypeError("Failed to fetch"));
    fireEvent.change(screen.getByRole("combobox", { name: /Reply to/ }), { target: { value: "Again" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reply" })));
    expect(screen.getByRole("alert").textContent).toContain("check your connection");
  });
});

describe("ProjectList", () => {
  const row = {
    id: "p1",
    name: "Apply for a thing",
    owner: { oid: "olive", name: "Olive Owner", email: null },
    access: "owner" as const,
    archivedAt: null,
    createdAt: "2026-11-01T09:00:00.000Z",
    updatedAt: "2026-11-01T09:00:00.000Z",
    links: 2,
    openThreads: 5,
    recordings: 1,
    lastActivityAt: "2026-11-12T09:00:00.000Z"
  };

  it("should list each project with its counts and last activity", () => {
    render(<ProjectList projects={[row, { ...row, id: "p2", name: "Other", access: "member", archivedAt: "2026-11-12T00:00:00.000Z" }]} archived />);

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByRole("link", { name: "Apply for a thing" }).getAttribute("href")).toBe("/assistant/feedback/p1");
    expect(rows[0]!.textContent).toContain("yours");
    expect(
      within(rows[0]!)
        .getAllByRole("cell")
        .map((cell) => cell.textContent)
        .slice(1, 4)
    ).toEqual(["2", "5", "1"]);
    expect(rows[1]!.textContent).toContain("Olive Owner's");
    expect(rows[1]!.textContent).toContain("archived");
    expect(screen.getByRole("link", { name: "Hide archived projects" }).getAttribute("href")).toBe("/assistant/feedback");
  });

  it("should send someone with no projects to the wizard", () => {
    render(<ProjectList projects={[]} archived={false} />);

    expect(screen.getByRole("link", { name: "Set up a feedback project" }).getAttribute("href")).toBe("/assistant/feedback/new");
    expect(screen.getByRole("link", { name: "Show archived projects" }).getAttribute("href")).toBe("/assistant/feedback?archived=1");
  });
});
