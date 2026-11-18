import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.ts";

const notify = vi.hoisted(() => ({ listNotifyTemplates: vi.fn(), pullNotifyTemplate: vi.fn() }));
vi.mock("./notify-tools.ts", () => ({ loadNotify: async () => notify }));

const { notifyList, notifyPull, POD_JOB_HANDLERS } = await import("./pod-job-handlers.ts");
const { PodJobError } = await import("./pod-jobs.ts");

const TEMPLATE = "ab1f3d4a-0000-4000-8000-000000000002";
const api = { getNotify: vi.fn(), putNotify: vi.fn() } as never;

function context(agentId: string | undefined) {
  return { jobId: "job-1", conversationId: "conv-1", agentId, signal: new AbortController().signal, api, env: {} as Env, say: () => undefined };
}

describe("the Notify pod-job handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should register both kinds, each inside the hub's time for it", () => {
    expect(POD_JOB_HANDLERS).toEqual([notifyList, notifyPull]);
    expect(notifyList.budgetMs).toBeLessThan(120_000);
    expect(notifyPull.budgetMs).toBeLessThan(150_000);
  });

  it("should list the product's templates", async () => {
    notify.listNotifyTemplates.mockResolvedValue({ templates: [], truncated: false });

    expect(await notifyList.run({ product: "pcs" }, context("agent-1"))).toEqual({ templates: [], truncated: false });
    expect(notify.listNotifyTemplates).toHaveBeenCalledWith("pcs");
  });

  it("should load the template through the frame's agent and answer the version alone", async () => {
    notify.pullNotifyTemplate.mockResolvedValue({ version: 3, name: "Claim", written: true });
    const ctx = context("agent-1");

    expect(await notifyPull.run({ product: "pcs", template_id: TEMPLATE }, ctx)).toEqual({ version: 3 });
    expect(notify.pullNotifyTemplate).toHaveBeenCalledWith({ productId: "pcs", templateId: TEMPLATE, agentId: "agent-1", api, signal: ctx.signal });
  });

  it("should answer no_session when the frame carried no agent to write through", async () => {
    await expect(notifyPull.run({ product: "pcs", template_id: TEMPLATE }, context(undefined))).rejects.toBeInstanceOf(PodJobError);
    await expect(notifyPull.run({ product: "pcs", template_id: TEMPLATE }, context(undefined))).rejects.toMatchObject({ code: "no_session" });
    expect(notify.pullNotifyTemplate).not.toHaveBeenCalled();
  });

  it.each([
    [notifyList, null],
    [notifyList, { product: "-bad" }],
    [notifyList, { product: 7 }],
    [notifyPull, { product: "pcs" }],
    [notifyPull, { product: "pcs", template_id: "not-a-uuid" }]
  ])("should refuse arguments it cannot run, checked again on the pod", async (handler, args) => {
    await expect(handler.run(args, context("agent-1"))).rejects.toThrow(/is not one this client can run/);
  });
});
