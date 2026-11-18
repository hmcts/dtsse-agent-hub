import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, MAX_REQUEST_BYTES } from "../agent-api/http.ts";

const mocks = vi.hoisted(() => ({
  viewerFrom: vi.fn(),
  virtualAgentsEnabled: vi.fn(),
  requestPodJob: vi.fn(),
  readPodJob: vi.fn(),
  answerablePodJob: vi.fn(),
  answerPodJob: vi.fn()
}));

vi.mock("@/viewer/identity", () => ({ viewerFrom: mocks.viewerFrom }));
vi.mock("@/virtual-agents/settings", () => ({ virtualAgentsEnabled: mocks.virtualAgentsEnabled }));
vi.mock("@/store/prisma", () => ({ prisma: {} }));
vi.mock("@/assistant/pod-job-store", () => ({
  requestPodJob: mocks.requestPodJob,
  readPodJob: mocks.readPodJob,
  answerablePodJob: mocks.answerablePodJob,
  answerPodJob: mocks.answerPodJob
}));
vi.mock("@/agent-api/route", () => ({
  virtualRoute:
    (handler: (request: unknown) => Promise<Response>) => async (request: Request, context: { params: Promise<{ virtualAgentId: string; jobId: string }> }) => {
      const params = await context.params;
      try {
        return await handler({ virtualAgent: { id: params.virtualAgentId, ownerOid: "owner" }, request, params });
      } catch (error) {
        return error instanceof HttpError ? Response.json({ error: error.message }, { status: error.status }) : Response.json({}, { status: 500 });
      }
    }
}));

const ask = await import("../app/api/ui/assistant/pod-jobs/[conversationId]/route.ts");
const read = await import("../app/api/ui/assistant/pod-jobs/[conversationId]/[jobId]/route.ts");
const answer = await import("../app/api/virtual/[virtualAgentId]/pod-jobs/[jobId]/route.ts");

const CONVERSATION = "c1";
const JOB = "j1";

function post(body: unknown): Promise<Response> {
  const request = new NextRequest(`http://hub/api/ui/assistant/pod-jobs/${CONVERSATION}`, { method: "POST", body: JSON.stringify(body) });
  return ask.POST(request, { params: Promise.resolve({ conversationId: CONVERSATION }) });
}

function get(): Promise<Response> {
  const request = new NextRequest(`http://hub/api/ui/assistant/pod-jobs/${CONVERSATION}/${JOB}`);
  return read.GET(request, { params: Promise.resolve({ conversationId: CONVERSATION, jobId: JOB }) });
}

function put(body: BodyInit): Promise<Response> {
  return answer.PUT(new Request(`http://hub/api/virtual/va-1/pod-jobs/${JOB}`, { method: "PUT", body }), {
    params: Promise.resolve({ virtualAgentId: "va-1", jobId: JOB })
  });
}

/** The pending job the store finds, of a kind whose answers are capped at `maxResultBytes`. */
const jobCapped = (maxResultBytes: unknown) => ({
  id: JOB,
  conversationId: CONVERSATION,
  ownerOid: "owner",
  virtualAgentId: "va-1",
  definition: { kind: "test.echo", maxResultBytes }
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.viewerFrom.mockResolvedValue({ oid: "owner" });
  mocks.virtualAgentsEnabled.mockReturnValue(true);
});

describe("POST /api/ui/assistant/pod-jobs/{conversation_id}", () => {
  it("should ask for the job as the signed-in person and answer what the store says, uncached", async () => {
    mocks.requestPodJob.mockResolvedValue({ status: "pending", job_id: JOB });

    const response = await post({ kind: "test.echo", args: { text: "hi" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "pending", job_id: JOB });
    expect(mocks.requestPodJob).toHaveBeenCalledWith({}, "owner", CONVERSATION, { kind: "test.echo", args: { text: "hi" } });
  });

  it("should pass nothing for a body that is not an object", async () => {
    mocks.requestPodJob.mockResolvedValue({ status: "no_pod" });

    await post(null);

    expect(mocks.requestPodJob).toHaveBeenCalledWith({}, "owner", CONVERSATION, { kind: undefined, args: undefined });
  });

  it("should answer the store's refusal with its status and extras", async () => {
    mocks.requestPodJob.mockRejectedValue(new HttpError(409, "already running", { job_id: "other" }));

    const response = await post({ kind: "test.echo" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "already running", job_id: "other" });
  });

  it("should answer 401 when nobody is signed in", async () => {
    mocks.viewerFrom.mockResolvedValue(undefined);

    expect((await post({})).status).toBe(401);
    expect(mocks.requestPodJob).not.toHaveBeenCalled();
  });

  it("should answer 404 when virtual agents are off", async () => {
    mocks.virtualAgentsEnabled.mockReturnValue(false);

    expect((await post({})).status).toBe(404);
    expect(mocks.requestPodJob).not.toHaveBeenCalled();
  });
});

describe("GET /api/ui/assistant/pod-jobs/{conversation_id}/{job_id}", () => {
  it("should answer the viewer's job, uncached", async () => {
    mocks.readPodJob.mockResolvedValue({ job_id: JOB, kind: "test.echo", status: "pending" });

    const response = await get();

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ job_id: JOB, kind: "test.echo", status: "pending" });
    expect(mocks.readPodJob).toHaveBeenCalledWith({}, "owner", CONVERSATION, JOB);
  });

  it("should answer 404 for a job the viewer may not read", async () => {
    mocks.readPodJob.mockResolvedValue(undefined);

    expect((await get()).status).toBe(404);
  });

  it("should answer 401 when nobody is signed in, and 404 when virtual agents are off", async () => {
    mocks.viewerFrom.mockResolvedValueOnce(undefined);
    expect((await get()).status).toBe(401);

    mocks.virtualAgentsEnabled.mockReturnValue(false);
    expect((await get()).status).toBe(404);
    expect(mocks.readPodJob).not.toHaveBeenCalled();
  });
});

describe("PUT /api/virtual/{id}/pod-jobs/{job_id}", () => {
  it("should ignore an answer to a job that is not pending without reading it", async () => {
    mocks.answerablePodJob.mockResolvedValue(undefined);

    const response = await put("not json");

    expect(response.status).toBe(204);
    expect(mocks.answerPodJob).not.toHaveBeenCalled();
  });

  it("should read an answer within the agent API's cap as JSON and hand it to the store", async () => {
    mocks.answerablePodJob.mockResolvedValue(jobCapped(MAX_REQUEST_BYTES));

    const response = await put(JSON.stringify({ status: "done", result: { echoed: "hi" } }));

    expect(response.status).toBe(204);
    expect(mocks.answerPodJob).toHaveBeenCalledWith({}, jobCapped(expect.any(Number)), { status: "done", result: { echoed: "hi" } });
  });

  it("should read a larger answer as bytes up to the kind's own cap", async () => {
    mocks.answerablePodJob.mockResolvedValue(jobCapped(MAX_REQUEST_BYTES * 2));
    const result = { echoed: "x".repeat(MAX_REQUEST_BYTES) };

    const response = await put(JSON.stringify({ status: "done", result }));

    expect(response.status).toBe(204);
    expect(mocks.answerPodJob).toHaveBeenCalledWith({}, jobCapped(expect.any(Number)), { status: "done", result });
  });

  it("should answer 413 for an answer over the kind's cap, and 400 for one that is not JSON", async () => {
    mocks.answerablePodJob.mockResolvedValue(jobCapped(MAX_REQUEST_BYTES * 2));

    const tooBig = await put("x".repeat(MAX_REQUEST_BYTES * 2 + 1));
    const notJson = await put("{");

    expect(tooBig.status).toBe(413);
    expect((await tooBig.json()).error).toContain(String(MAX_REQUEST_BYTES * 2));
    expect(notJson.status).toBe(400);
    expect(mocks.answerPodJob).not.toHaveBeenCalled();
  });

  it("should pass on any other fault reading a larger answer", async () => {
    mocks.answerablePodJob.mockResolvedValue(jobCapped(MAX_REQUEST_BYTES * 2));
    const broken = new ReadableStream({
      pull(controller) {
        controller.error(new Error("socket closed"));
      }
    });

    const response = await answer.PUT(
      new Request(`http://hub/api/virtual/va-1/pod-jobs/${JOB}`, { method: "PUT", body: broken, duplex: "half" } as RequestInit),
      {
        params: Promise.resolve({ virtualAgentId: "va-1", jobId: JOB })
      }
    );

    expect(response.status).toBe(500);
  });

  it("should answer 413 when the answer is over a kind's cap that is under the agent API's", async () => {
    mocks.answerablePodJob.mockResolvedValue(jobCapped(2048));

    const tooBig = await put(JSON.stringify({ status: "done", result: { echoed: "x".repeat(2048) } }));

    expect(tooBig.status).toBe(413);
    expect((await tooBig.json()).error).toBe("the answer is larger than 2048 bytes");
    expect(mocks.answerPodJob).not.toHaveBeenCalled();
  });

  it("should answer the store's 400 for an answer the kind does not allow", async () => {
    mocks.answerablePodJob.mockResolvedValue(jobCapped(MAX_REQUEST_BYTES));
    mocks.answerPodJob.mockRejectedValue(new HttpError(400, "result: bad"));

    expect((await put(JSON.stringify({ status: "done", result: 1 }))).status).toBe(400);
  });
});
