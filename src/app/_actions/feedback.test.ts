import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/agent-api/http";

const store = {
  createProject: vi.fn(),
  addLink: vi.fn(),
  revokeLink: vi.fn(),
  rotateLink: vi.fn(),
  setMembers: vi.fn(),
  updateSettings: vi.fn(),
  archiveProject: vi.fn(),
  getProject: vi.fn()
};
const threads = { replyToThread: vi.fn(), patchThread: vi.fn(), listThreads: vi.fn() };
const refinements = { setThreadsTheme: vi.fn(), refinableThreads: vi.fn(), recordRefinement: vi.fn() };
const startConversation = vi.fn();
const deleteConversation = vi.fn();
const mentions = { markMentionsSeen: vi.fn() };
const probeTarget = vi.fn();
let enabled = true;
let resolves = true;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/viewer/current", () => ({ requireViewer: async () => ({ oid: "alice-oid" }) }));
vi.mock("@/store/prisma", () => ({ prisma: {} }));
vi.mock("@/feedback/settings", () => ({ feedbackEnabled: () => enabled }));
vi.mock("@/feedback/store", () => store);
vi.mock("@/feedback/thread-store", () => threads);
vi.mock("@/feedback/mention-store", () => mentions);
vi.mock("@/feedback/refinement-store", () => refinements);
vi.mock("@/app/_actions/assistant", () => ({
  startConversation: (...args: unknown[]) => startConversation(...args),
  deleteConversation: (...args: unknown[]) => deleteConversation(...args)
}));
vi.mock("@/feedback/probe", () => ({ probeTarget: (...args: unknown[]) => probeTarget(...args) }));
vi.mock("@/feedback/targets", async (original) => ({
  ...(await original<typeof import("@/feedback/targets")>()),
  publicAddresses: async () => (resolves ? [{ address: "8.8.8.8", family: 4 }] : [])
}));

const actions = await import("./feedback.ts");

const LINK = { label: "Start", url: "https://proto.example.com/start" };

beforeEach(() => {
  enabled = true;
  resolves = true;
  for (const fn of [...Object.values(store), ...Object.values(threads), probeTarget]) {
    fn.mockReset();
  }
});

describe("createFeedbackProject", () => {
  it("should create the viewer's project from the wizard's snake_case body", async () => {
    store.createProject.mockResolvedValue({ id: "p1" });

    expect(await actions.createFeedbackProject({ name: " Research ", links: [LINK], member_oids: ["bob"], mask_inputs: true, retention_days: 30 })).toEqual({
      ok: true,
      project: { id: "p1" }
    });
    expect(store.createProject).toHaveBeenCalledWith({}, "alice-oid", {
      name: "Research",
      links: [{ label: "Start", targetUrl: LINK.url, prototypeVersion: null }],
      memberOids: ["bob"],
      maskInputs: true,
      retentionDays: 30
    });
  });

  it("should refuse a link that is not on the public internet, naming it, and save nothing", async () => {
    resolves = false;

    expect(await actions.createFeedbackProject({ name: "R", links: [LINK] })).toEqual({ ok: false, error: "links.0.url: must be on the public internet" });
    expect(await actions.createFeedbackProject({ name: "R", links: [{ label: "x", url: "https://localhost/" }] })).toEqual({
      ok: false,
      error: "links.0.url: must be on the public internet"
    });
    expect(store.createProject).not.toHaveBeenCalled();
  });

  it("should refuse a body the schema does not allow", async () => {
    expect(await actions.createFeedbackProject({ name: "R", links: [] })).toMatchObject({ ok: false });
  });

  it("should refuse everything while feedback is off", async () => {
    enabled = false;
    const off = { ok: false, error: "prototype feedback is not available on this deployment" };

    expect(await actions.createFeedbackProject({})).toEqual(off);
    expect(await actions.addFeedbackLink({ projectId: "p", link: LINK })).toEqual(off);
    expect(await actions.revokeFeedbackLink({ projectId: "p", linkId: "l" })).toEqual(off);
    expect(await actions.rotateFeedbackLink({ projectId: "p", linkId: "l" })).toEqual(off);
    expect(await actions.setFeedbackMembers({ projectId: "p", memberOids: [] })).toEqual(off);
    expect(await actions.updateFeedbackSettings({ projectId: "p", settings: {} })).toEqual(off);
    expect(await actions.archiveFeedbackProject({ projectId: "p" })).toEqual(off);
    expect(await actions.replyToFeedbackThread({ projectId: "p", threadId: "t", body: "x" })).toEqual(off);
    expect(await actions.setFeedbackThreadStatus({ projectId: "p", threadId: "t", status: "open" })).toEqual(off);
    expect(await actions.probeFeedbackLink({ url: "https://x.example.com" })).toEqual(off);
  });
});

describe("the owner's changes", () => {
  it("should pass each change to the store as the viewer", async () => {
    store.addLink.mockResolvedValue({ id: "l2" });
    store.rotateLink.mockResolvedValue({ id: "l1" });
    store.setMembers.mockResolvedValue([]);
    store.updateSettings.mockResolvedValue({ id: "p" });

    expect(await actions.addFeedbackLink({ projectId: "p", link: { ...LINK, prototype_version: "v2" } })).toEqual({ ok: true, link: { id: "l2" } });
    expect(store.addLink).toHaveBeenCalledWith({}, "alice-oid", "p", { label: "Start", targetUrl: LINK.url, prototypeVersion: "v2" });
    expect(await actions.revokeFeedbackLink({ projectId: "p", linkId: "l1" })).toEqual({ ok: true });
    expect(store.revokeLink).toHaveBeenCalledWith({}, "alice-oid", "p", "l1");
    expect(await actions.rotateFeedbackLink({ projectId: "p", linkId: "l1" })).toEqual({ ok: true, link: { id: "l1" } });
    expect(await actions.setFeedbackMembers({ projectId: "p", memberOids: ["bob"] })).toEqual({ ok: true, members: [] });
    expect(store.setMembers).toHaveBeenCalledWith({}, "alice-oid", "p", ["bob"]);
    expect(await actions.updateFeedbackSettings({ projectId: "p", settings: { retention_days: 7 } })).toEqual({ ok: true, project: { id: "p" } });
    expect(store.updateSettings).toHaveBeenCalledWith({}, "alice-oid", "p", { name: undefined, maskInputs: undefined, retentionDays: 7 });
    expect(await actions.archiveFeedbackProject({ projectId: "p" })).toEqual({ ok: true });
  });

  it("should show the store's refusal, such as a member who is not the owner", async () => {
    store.archiveProject.mockRejectedValue(new HttpError(403, "only the project's owner can change it"));

    expect(await actions.archiveFeedbackProject({ projectId: "p" })).toEqual({ ok: false, error: "only the project's owner can change it" });
  });
});

describe("the team's replies", () => {
  it("should reply and resolve through the project's scope", async () => {
    threads.replyToThread.mockResolvedValue({ id: "c" });
    threads.patchThread.mockResolvedValue({ id: "t" });

    expect(await actions.replyToFeedbackThread({ projectId: "p", threadId: "t", body: " Thanks " })).toEqual({ ok: true, comment: { id: "c" } });
    expect(threads.replyToThread).toHaveBeenCalledWith({}, "alice-oid", { projectId: "p" }, "t", "Thanks");
    expect(await actions.setFeedbackThreadStatus({ projectId: "p", threadId: "t", status: "resolved" })).toEqual({ ok: true, thread: { id: "t" } });
    expect(threads.patchThread).toHaveBeenCalledWith({}, "alice-oid", { projectId: "p" }, "t", { status: "resolved" });
  });

  it("should refuse a status other than open or resolved", async () => {
    expect(await actions.setFeedbackThreadStatus({ projectId: "p", threadId: "t", status: "detached" })).toEqual({
      ok: false,
      error: "status: must be open or resolved"
    });
  });
});

describe("probeFeedbackLink", () => {
  it("should answer what the probe found", async () => {
    probeTarget.mockResolvedValue({ result: "pass", status: 200, reason: "it answered 200" });

    expect(await actions.probeFeedbackLink({ url: " https://proto.example.com " })).toEqual({
      ok: true,
      probe: { result: "pass", status: 200, reason: "it answered 200" }
    });
    expect(probeTarget).toHaveBeenCalledWith("https://proto.example.com");
  });
});

describe("markFeedbackMentionsSeen", () => {
  beforeEach(() => {
    enabled = true;
    mentions.markMentionsSeen.mockReset();
  });

  it("should mark the viewer's mentions on the comments given, ignoring anything that is not an id", async () => {
    mentions.markMentionsSeen.mockResolvedValue(1);
    const { revalidatePath } = await import("next/cache");
    vi.mocked(revalidatePath).mockClear();

    expect(await actions.markFeedbackMentionsSeen({ commentIds: ["c1", 7, "c2"] })).toEqual({ ok: true });

    expect(mentions.markMentionsSeen).toHaveBeenCalledWith({}, "alice-oid", ["c1", "c2"]);
    expect(revalidatePath).toHaveBeenCalledWith("/assistant", "layout");
  });

  it("should re-render nothing when nothing was newly seen, and mark nothing when given no list", async () => {
    mentions.markMentionsSeen.mockResolvedValue(0);
    const { revalidatePath } = await import("next/cache");
    vi.mocked(revalidatePath).mockClear();

    expect(await actions.markFeedbackMentionsSeen({ commentIds: "c1" })).toEqual({ ok: true });

    expect(mentions.markMentionsSeen).toHaveBeenCalledWith({}, "alice-oid", []);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("should refuse while prototype feedback is off", async () => {
    enabled = false;

    expect(await actions.markFeedbackMentionsSeen({ commentIds: [] })).toEqual({ ok: false, error: "prototype feedback is not available on this deployment" });
    expect(mentions.markMentionsSeen).not.toHaveBeenCalled();
  });
});

describe("setFeedbackTheme", () => {
  beforeEach(() => {
    enabled = true;
    refinements.setThreadsTheme.mockReset().mockResolvedValue(2);
  });

  it("should give the chosen threads the theme, as the store checks it, and say how many changed", async () => {
    expect(await actions.setFeedbackTheme({ projectId: "p1", threadIds: ["t1", 3, "t2"], theme: "  Court  fees " })).toEqual({ ok: true, changed: 2 });

    expect(refinements.setThreadsTheme).toHaveBeenCalledWith({}, "alice-oid", "p1", ["t1", "t2"], "Court fees");
  });

  it("should clear a theme, and refuse one too long without asking the store", async () => {
    await actions.setFeedbackTheme({ projectId: "p1", threadIds: "t1", theme: null });
    expect(refinements.setThreadsTheme).toHaveBeenCalledWith({}, "alice-oid", "p1", [], null);

    refinements.setThreadsTheme.mockClear();
    expect(await actions.setFeedbackTheme({ projectId: "p1", threadIds: ["t1"], theme: "x".repeat(61) })).toEqual({
      ok: false,
      error: "Keep the theme to 60 characters"
    });
    expect(refinements.setThreadsTheme).not.toHaveBeenCalled();
    expect(await actions.setFeedbackTheme({ projectId: "p1", threadIds: ["t1"], theme: 7 })).toEqual({
      ok: false,
      error: "theme: must be text, or null to clear it"
    });
  });

  it("should refuse while prototype feedback is off", async () => {
    enabled = false;

    expect((await actions.setFeedbackTheme({ projectId: "p1", threadIds: [], theme: "x" })).ok).toBe(false);
  });
});

describe("refineFeedback", () => {
  const T = (id: string, linkId = "l1") => ({
    id,
    linkId,
    pagePath: "/start",
    pageTitle: null,
    theme: null,
    anchor: { selector: "#x", text: "Start now", tag: "a", rect: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 1, height: 1 } },
    status: "open",
    createdAt: "2026-11-10T10:00:00.000Z",
    comments: [{ id: `${id}-c`, author: { oid: "ben", name: "Ben" }, body: `about ${id}`, createdAt: "2026-11-10T10:00:00.000Z", mentions: [] }]
  });

  beforeEach(() => {
    enabled = true;
    refinements.refinableThreads.mockReset().mockResolvedValue(["t1", "t2"]);
    refinements.recordRefinement.mockReset().mockResolvedValue(undefined);
    store.getProject.mockReset().mockResolvedValue({ name: "Claims", links: [{ id: "l1", label: "Version 1" }] });
    threads.listThreads.mockReset().mockResolvedValue([T("t1"), T("t2"), T("t3")]);
    startConversation.mockReset().mockResolvedValue({ ok: true, id: "conv-1" });
  });

  it("should start a conversation with the refinable threads, record it, and answer its id", async () => {
    expect(await actions.refineFeedback({ projectId: "p1", threadIds: ["t1", "t2", 9], mode: "each" })).toEqual({ ok: true, id: "conv-1" });

    expect(refinements.refinableThreads).toHaveBeenCalledWith({}, "alice-oid", "p1", ["t1", "t2"]);
    const request = startConversation.mock.calls[0]?.[0] as { product: string; title: string; body: string };
    expect(request.title).toMatch(/^Refine feedback: Claims, /);
    expect(request.body).toContain("about t1");
    expect(request.body).toContain("about t2");
    expect(request.body).not.toContain("about t3");
    expect(request.body).not.toContain("Version 1");
    expect(refinements.recordRefinement).toHaveBeenCalledWith({}, "alice-oid", "p1", "conv-1", ["t1", "t2"]);
    expect(Object.keys(startConversation.mock.calls[0]?.[0] as object).sort()).toEqual(["body", "product", "title"]);
  });

  it("should name each comment's link when the project has more than one", async () => {
    store.getProject.mockResolvedValue({
      name: "Claims",
      links: [
        { id: "l1", label: "Version 1" },
        { id: "l2", label: "Version 2" }
      ]
    });
    threads.listThreads.mockResolvedValue([T("t1", "l2"), T("t2", "gone")]);

    await actions.refineFeedback({ projectId: "p1", threadIds: ["t1", "t2"], mode: "each" });

    const [[request]] = startConversation.mock.calls as [[{ body: string }]];
    const body = request.body;
    expect(body).toContain("On /start, Version 2,");
    expect(body).toContain("On /start, a removed link,");
  });

  it("should pass on why the conversation could not start, and record nothing", async () => {
    startConversation.mockResolvedValue({ ok: false, error: "Connect GitHub and Claude to start chatting" });

    expect(await actions.refineFeedback({ projectId: "p1", threadIds: ["t1"], mode: "each" })).toEqual({
      ok: false,
      error: "Connect GitHub and Claude to start chatting"
    });
    expect(refinements.recordRefinement).not.toHaveBeenCalled();
  });

  it("should refuse a mode that is neither one nor each, before starting anything", async () => {
    expect(await actions.refineFeedback({ projectId: "p1", threadIds: ["t1"], mode: "all" })).toEqual({ ok: false, error: "mode: must be one or each" });
    expect(startConversation).not.toHaveBeenCalled();
  });

  it("should ask for one story when that is the mode", async () => {
    await actions.refineFeedback({ projectId: "p1", threadIds: ["t1"], mode: "one" });

    const [[request]] = startConversation.mock.calls as [[{ body: string }]];
    expect(request.body).toContain("Please turn these comments into one Jira story.");
  });

  it("should delete the chat it started when the refinement cannot be recorded, and say why", async () => {
    refinements.recordRefinement.mockRejectedValue(new HttpError(409, "that project is archived"));
    deleteConversation.mockReset().mockResolvedValue({ ok: true });

    expect(await actions.refineFeedback({ projectId: "p1", threadIds: ["t1"], mode: "each" })).toEqual({ ok: false, error: "that project is archived" });
    expect(deleteConversation).toHaveBeenCalledWith({ conversationId: "conv-1" });
  });

  it("should refuse while prototype feedback is off", async () => {
    enabled = false;

    expect((await actions.refineFeedback({ projectId: "p1", threadIds: ["t1"], mode: "each" })).ok).toBe(false);
    expect(startConversation).not.toHaveBeenCalled();
  });
});
