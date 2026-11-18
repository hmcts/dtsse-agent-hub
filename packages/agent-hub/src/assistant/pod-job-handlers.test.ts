import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.ts";

const notify = vi.hoisted(() => ({ listNotifyTemplates: vi.fn(), pullNotifyTemplate: vi.fn() }));
vi.mock("./notify-tools.ts", () => ({ loadNotify: async () => notify }));

const { notifyList, notifyPull, POD_JOB_HANDLERS } = await import("./pod-job-handlers.ts");
const { PodJobError } = await import("./pod-jobs.ts");

const TEMPLATE = "ab1f3d4a-0000-4000-8000-000000000002";
const api = { listNotify: vi.fn(), getNotifyById: vi.fn(), putNotifyById: vi.fn(), createNotify: vi.fn() } as never;
const ITEM = "0b1f3d4a-0000-4000-8000-0000000000c1";

function context(agentId: string | undefined) {
  return { jobId: "job-1", conversationId: "conv-1", agentId, signal: new AbortController().signal, api, env: {} as Env, say: () => undefined };
}

describe("the Notify pod-job handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should register both kinds, each inside the hub's time for it", () => {
    expect(POD_JOB_HANDLERS).toEqual(expect.arrayContaining([notifyList, notifyPull]));
    expect(notifyList.budgetMs).toBeLessThan(120_000);
    expect(notifyPull.budgetMs).toBeLessThan(150_000);
  });

  it("should list the product's templates", async () => {
    notify.listNotifyTemplates.mockResolvedValue({ templates: [], truncated: false });

    expect(await notifyList.run({ product: "pcs" }, context("agent-1"))).toEqual({ templates: [], truncated: false });
    expect(notify.listNotifyTemplates).toHaveBeenCalledWith("pcs");
  });

  it("should load the template through the frame's agent as the person's, always into a new template, when no target is named, and answer the version and the template", async () => {
    notify.pullNotifyTemplate.mockResolvedValue({ id: ITEM, version: 3, name: "Claim", written: true });
    const ctx = context("agent-1");

    expect(await notifyPull.run({ product: "pcs", template_id: TEMPLATE }, ctx)).toEqual({ version: 3, item_id: ITEM });
    expect(notify.pullNotifyTemplate).toHaveBeenCalledWith({
      productId: "pcs",
      templateId: TEMPLATE,
      agentId: "agent-1",
      target: undefined,
      api,
      signal: ctx.signal,
      by: "user",
      create: true,
      jobId: "job-1"
    });
  });

  it("should load into the template the job names when it names one", async () => {
    notify.pullNotifyTemplate.mockResolvedValue({ id: ITEM, version: 4, name: "Claim", written: true });
    const ctx = context("agent-1");

    await notifyPull.run({ product: "pcs", template_id: TEMPLATE, item_id: ITEM }, ctx);

    expect(notify.pullNotifyTemplate).toHaveBeenCalledWith(expect.objectContaining({ target: ITEM, create: false }));
    await expect(notifyPull.run({ product: "pcs", template_id: TEMPLATE, item_id: "nope" }, ctx)).rejects.toThrow("item_id");
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
