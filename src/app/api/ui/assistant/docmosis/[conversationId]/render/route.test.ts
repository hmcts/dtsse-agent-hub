import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/agent-api/http";

const mocks = vi.hoisted(() => ({
  viewerFrom: vi.fn(),
  docmosisAccess: vi.fn(),
  renderTemplate: vi.fn(),
  writeUserDocmosisData: vi.fn(),
  docmosisView: vi.fn(),
  readDocmosisDocx: vi.fn(),
  storeDocmosisRender: vi.fn()
}));

vi.mock("@/viewer/identity", () => ({ viewerFrom: mocks.viewerFrom }));
vi.mock("@/web/data", () => ({ docmosisAccess: mocks.docmosisAccess }));
vi.mock("@/store/prisma", () => ({ prisma: {} }));
vi.mock("@/assistant/doc-render", () => ({ renderTemplate: mocks.renderTemplate }));
vi.mock("@/assistant/docmosis-store", () => ({
  writeUserDocmosisData: mocks.writeUserDocmosisData,
  docmosisView: mocks.docmosisView,
  readDocmosisDocx: mocks.readDocmosisDocx,
  storeDocmosisRender: mocks.storeDocmosisRender
}));

import { POST } from "./route";

const ID = "c1";
const BODY = { data: { name: "Ada" }, base_version: 2, base_revision: 0 };
const DOCX = new Uint8Array([1, 2, 3]);
const PDF = new Uint8Array([4, 5, 6]);

function post(body: unknown, id = ID): Promise<Response> {
  const request = new NextRequest(`http://hub/api/ui/assistant/docmosis/${id}/render`, { method: "POST", body: JSON.stringify(body) });
  return POST(request, { params: Promise.resolve({ conversationId: id }) });
}

describe("POST /api/ui/assistant/docmosis/{id}/render", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.viewerFrom.mockResolvedValue({ oid: "owner" });
    mocks.docmosisAccess.mockResolvedValue("owner");
    mocks.writeUserDocmosisData.mockResolvedValue({ version: 3, revision: 1 });
    mocks.docmosisView.mockResolvedValue({ name: "Claim", docx: "sha256:abc" });
    mocks.readDocmosisDocx.mockResolvedValue(DOCX);
    mocks.renderTemplate.mockResolvedValue({ ok: true, pdf: PDF });
    mocks.storeDocmosisRender.mockResolvedValue(true);
  });

  it("should answer 401 when nobody is signed in", async () => {
    mocks.viewerFrom.mockResolvedValue(undefined);
    expect((await post(BODY)).status).toBe(401);
  });

  it("should answer 404 when the viewer may not read the template", async () => {
    mocks.docmosisAccess.mockResolvedValue(undefined);
    expect((await post(BODY)).status).toBe(404);
    expect(mocks.writeUserDocmosisData).not.toHaveBeenCalled();
  });

  it("should answer 403 when the viewer is a reader", async () => {
    mocks.docmosisAccess.mockResolvedValue("reader");
    expect((await post(BODY)).status).toBe(403);
    expect(mocks.writeUserDocmosisData).not.toHaveBeenCalled();
  });

  it.each([[{ data: "x", base_version: 1, base_revision: 0 }], [{ data: {}, base_version: -1, base_revision: 0 }], [{ data: {}, base_version: 1 }]])(
    "should answer 400 for the malformed body %j",
    async (body) => {
      expect((await post(body)).status).toBe(400);
    }
  );

  it("should save the data, render the saved docx and store the PDF", async () => {
    const response = await post(BODY);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ version: 3, revision: 1, status: "rendered" });
    expect(mocks.writeUserDocmosisData).toHaveBeenCalledWith({}, { conversationId: ID, editorOid: "owner", data: BODY.data, baseVersion: 2, baseRevision: 0 });
    expect(mocks.readDocmosisDocx).toHaveBeenCalledWith({}, ID, "abc");
    expect(mocks.renderTemplate).toHaveBeenCalledWith({ docx: DOCX, data: BODY.data, name: "Claim" });
    expect(mocks.storeDocmosisRender).toHaveBeenCalledWith({}, { conversationId: ID, version: 3, revision: 1, pdf: PDF });
  });

  it("should store and return a merge error as a failed render", async () => {
    mocks.renderTemplate.mockResolvedValue({ ok: false, kind: "merge", short: "bad", long: "very bad" });
    const response = await post(BODY);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 3, revision: 1, status: "failed", error: { short: "bad", long: "very bad" } });
    expect(mocks.storeDocmosisRender).toHaveBeenCalledWith({}, { conversationId: ID, version: 3, revision: 1, error: { short: "bad", long: "very bad" } });
  });

  it("should answer 503 with Retry-After when the renderer is busy, storing nothing", async () => {
    mocks.renderTemplate.mockResolvedValue({ ok: false, kind: "busy", retryAfter: 7 });
    const response = await post(BODY);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(await response.json()).toEqual({ error: "the renderer is busy", retry_after: 7, version: 3, revision: 1 });
    expect(mocks.storeDocmosisRender).not.toHaveBeenCalled();
  });

  it("should answer 502 when the renderer is unreachable, storing nothing", async () => {
    mocks.renderTemplate.mockResolvedValue({ ok: false, kind: "unreachable", message: "fetch failed" });
    const response = await post(BODY);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({ version: 3, revision: 1 });
    expect(body.error).toContain("fetch failed");
    expect(mocks.storeDocmosisRender).not.toHaveBeenCalled();
  });

  it("should answer 409 with the current version when the render was superseded", async () => {
    mocks.storeDocmosisRender.mockResolvedValue(false);
    mocks.docmosisView.mockResolvedValueOnce({ name: "Claim", docx: "sha256:abc" }).mockResolvedValueOnce({ version: 4 });
    const response = await post(BODY);
    expect(response.status).toBe(409);
    expect((await response.json()).current).toEqual({ version: 4 });
  });

  it("should pass on a 409 from the save with the current version", async () => {
    mocks.writeUserDocmosisData.mockRejectedValue(new HttpError(409, "stale", { current: { version: 5 } }));
    const response = await post(BODY);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "stale", current: { version: 5 } });
    expect(mocks.renderTemplate).not.toHaveBeenCalled();
  });

  it.each([
    ["version", () => mocks.docmosisView.mockResolvedValue(null)],
    ["docx", () => mocks.readDocmosisDocx.mockResolvedValue(null)]
  ])("should answer 404 when the saved %s is not held", async (_label, arrange) => {
    arrange();
    expect((await post(BODY)).status).toBe(404);
    expect(mocks.renderTemplate).not.toHaveBeenCalled();
  });

  it("should answer 429 to a second render of the same conversation while one is under way, then let the next through", async () => {
    let finish: (value: unknown) => void = () => undefined;
    mocks.renderTemplate.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const first = post(BODY);
    await vi.waitFor(() => expect(mocks.renderTemplate).toHaveBeenCalled());
    const second = await post(BODY);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("2");
    expect(await second.json()).toMatchObject({ version: 2, revision: 0 });
    finish({ ok: true, pdf: PDF });
    expect((await first).status).toBe(200);
    expect((await post(BODY)).status).toBe(200);
  });

  it("should let two different conversations render at once", async () => {
    let finish: (value: unknown) => void = () => undefined;
    mocks.renderTemplate.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const first = post(BODY);
    await vi.waitFor(() => expect(mocks.renderTemplate).toHaveBeenCalled());
    expect((await post(BODY, "c2")).status).toBe(200);
    finish({ ok: true, pdf: PDF });
    await first;
  });

  it("should release the conversation's slot when the render throws", async () => {
    mocks.renderTemplate.mockRejectedValueOnce(new Error("boom"));
    expect((await post(BODY)).status).toBe(500);
    expect((await post(BODY)).status).toBe(200);
  });
});
