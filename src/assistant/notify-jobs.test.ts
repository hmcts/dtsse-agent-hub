import { describe, expect, it } from "vitest";
import { HttpError } from "../agent-api/http.ts";
import { MAX_LISTED_TEMPLATES, NOTIFY_JOB_ERRORS, NOTIFY_LIST, NOTIFY_PULL } from "./notify-jobs.ts";
import { checkPodJobAnswer, checkPodJobArgs } from "./pod-jobs.ts";

const ID = "ab1f3d4a-0000-4000-8000-000000000002";

function refused(call: () => unknown): HttpError {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error("expected a refusal");
}

describe("notify.list", () => {
  it("should take a product the CFT Workspace has a Notify key for, and nothing else", () => {
    expect(checkPodJobArgs(NOTIFY_LIST, { product: "pcs" })).toEqual({ product: "pcs" });
    expect(refused(() => checkPodJobArgs(NOTIFY_LIST, { product: "nope" })).message).toMatch(/^args\.product: is not a product/);
    expect(refused(() => checkPodJobArgs(NOTIFY_LIST, { product: "pcs", vault: "x" })).status).toBe(400);
    expect(refused(() => checkPodJobArgs(NOTIFY_LIST, {})).status).toBe(400);
  });

  it("should take a list of templates, lowercasing their ids, and refuse one too long", () => {
    const answer = checkPodJobAnswer(NOTIFY_LIST, {
      status: "done",
      result: { templates: [{ id: ID.toUpperCase(), name: "Claim", type: "email", version: 4 }], truncated: false }
    });
    expect(answer).toEqual({ status: "done", result: { templates: [{ id: ID, name: "Claim", type: "email", version: 4 }], truncated: false } });

    const many = Array.from({ length: MAX_LISTED_TEMPLATES + 1 }, () => ({ id: ID, name: "x", type: "sms", version: 1 }));
    expect(refused(() => checkPodJobAnswer(NOTIFY_LIST, { status: "done", result: { templates: many, truncated: true } })).message).toMatch(
      /at most 1000 templates/
    );
    expect(
      refused(() =>
        checkPodJobAnswer(NOTIFY_LIST, { status: "done", result: { templates: [{ id: ID, name: "x", type: "fax", version: 1 }], truncated: false } })
      ).status
    ).toBe(400);
  });

  it("should keep each of its codes and store any other as failed", () => {
    for (const code of NOTIFY_JOB_ERRORS) {
      expect(checkPodJobAnswer(NOTIFY_LIST, { status: "failed", error: code, detail: "words" })).toEqual({ status: "failed", error: code, detail: "words" });
    }
    expect(checkPodJobAnswer(NOTIFY_LIST, { status: "failed", error: "busy" })).toEqual({ status: "failed", error: "failed" });
  });

  it("should give the pod time for az and Notify, and a 1 MiB answer", () => {
    expect(NOTIFY_LIST.timeoutMs).toBe(120_000);
    expect(NOTIFY_LIST.maxResultBytes).toBe(1024 * 1024);
    expect(NOTIFY_LIST.oneAtATime).toBe(false);
  });
});

describe("notify.pull", () => {
  it("should take a product and a template id, and answer the version written", () => {
    expect(checkPodJobArgs(NOTIFY_PULL, { product: "sptribs", template_id: ID })).toEqual({ product: "sptribs", template_id: ID });
    expect(refused(() => checkPodJobArgs(NOTIFY_PULL, { product: "sptribs", template_id: "x" })).message).toMatch(/args\.template_id: must be a UUID/);
    expect(checkPodJobAnswer(NOTIFY_PULL, { status: "done", result: { version: 2 } })).toEqual({ status: "done", result: { version: 2 } });
    expect(refused(() => checkPodJobAnswer(NOTIFY_PULL, { status: "done", result: { version: 0 } })).status).toBe(400);
  });

  it("should run one at a time in a conversation", () => {
    expect(NOTIFY_PULL.oneAtATime).toBe(true);
    expect(NOTIFY_PULL.timeoutMs).toBe(150_000);
  });
});
