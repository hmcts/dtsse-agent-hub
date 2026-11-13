import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/agent-api/http";

const store = {
  createProject: vi.fn(),
  addLink: vi.fn(),
  revokeLink: vi.fn(),
  rotateLink: vi.fn(),
  setMembers: vi.fn(),
  updateSettings: vi.fn(),
  archiveProject: vi.fn()
};
const threads = { replyToThread: vi.fn(), patchThread: vi.fn() };
const probeTarget = vi.fn();
let enabled = true;
let resolves = true;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/viewer/current", () => ({ requireViewer: async () => ({ oid: "alice-oid" }) }));
vi.mock("@/store/prisma", () => ({ prisma: {} }));
vi.mock("@/feedback/settings", () => ({ feedbackEnabled: () => enabled }));
vi.mock("@/feedback/store", () => store);
vi.mock("@/feedback/thread-store", () => threads);
vi.mock("@/feedback/probe", () => ({ probeTarget: (...args: unknown[]) => probeTarget(...args) }));
vi.mock("@/feedback/targets", async (original) => ({
  ...(await original<typeof import("@/feedback/targets")>()),
  resolvesPublic: async () => resolves
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
