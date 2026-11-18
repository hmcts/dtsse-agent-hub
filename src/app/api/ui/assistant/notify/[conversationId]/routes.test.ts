import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/agent-api/http";

const mocks = vi.hoisted(() => ({
  viewerFrom: vi.fn(),
  readableNotify: vi.fn(),
  notifyVersions: vi.fn(),
  notifyAccess: vi.fn(),
  writeUserNotify: vi.fn()
}));

vi.mock("@/viewer/identity", () => ({ viewerFrom: mocks.viewerFrom }));
vi.mock("@/web/data", () => ({ readableNotify: mocks.readableNotify, notifyVersions: mocks.notifyVersions, notifyAccess: mocks.notifyAccess }));
vi.mock("@/store/prisma", () => ({ prisma: {} }));
vi.mock("@/assistant/notify-store", () => ({ writeUserNotify: mocks.writeUserNotify }));

import { GET as getLatest } from "./route";
import { POST as save } from "./save/route";
import { GET as getVersion } from "./versions/[version]/route";
import { GET as getVersions } from "./versions/route";

const ID = "c1";
const TEMPLATE = { version: 3, name: "Claim received" };
const SAVE = { subject: "Claim", body: "Dear ((name))", data: { name: "Ada" }, base_version: 3, base_revision: 0 };

type Handler = (request: NextRequest, context: { params: Promise<never> }) => Promise<Response>;

function call(handler: Handler, params: Record<string, string> = {}, body?: unknown): Promise<Response> {
  const request = new NextRequest("http://hub/api/ui/assistant/notify/x", body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  return handler(request, { params: Promise.resolve({ conversationId: ID, ...params }) as Promise<never> });
}

describe("the Notify template's browser routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.viewerFrom.mockResolvedValue({ oid: "owner" });
  });

  it.each([
    ["latest", getLatest as Handler],
    ["versions", getVersions as Handler],
    ["version", getVersion as Handler],
    ["save", save as Handler]
  ])("should answer 401 for the %s route when nobody is signed in", async (_label, handler) => {
    mocks.viewerFrom.mockResolvedValue(undefined);
    expect((await call(handler, { version: "1" }, {})).status).toBe(401);
  });

  it("should return the latest version with no-store, and 404 when there is nothing the viewer may read", async () => {
    mocks.readableNotify.mockResolvedValueOnce(TEMPLATE).mockResolvedValueOnce(undefined);

    const found = await call(getLatest as Handler);
    const missing = await call(getLatest as Handler);

    expect(found.status).toBe(200);
    expect(found.headers.get("cache-control")).toBe("no-store");
    expect(await found.json()).toEqual(TEMPLATE);
    expect(mocks.readableNotify).toHaveBeenCalledWith({ oid: "owner" }, ID);
    expect(missing.status).toBe(404);
  });

  it("should wrap the versions in an object, and 404 when there are none the viewer may read", async () => {
    mocks.notifyVersions.mockResolvedValueOnce([{ version: 3 }]).mockResolvedValueOnce(undefined);

    const found = await call(getVersions as Handler);
    const missing = await call(getVersions as Handler);

    expect(await found.json()).toEqual({ versions: [{ version: 3 }] });
    expect(found.headers.get("cache-control")).toBe("no-store");
    expect(missing.status).toBe(404);
  });

  it("should read one version, and 404 for a version that is not a number or not there", async () => {
    mocks.readableNotify.mockResolvedValueOnce(TEMPLATE).mockResolvedValueOnce(undefined);

    const found = await call(getVersion as Handler, { version: "2" });
    const gone = await call(getVersion as Handler, { version: "9" });
    const bad = await call(getVersion as Handler, { version: "two" });

    expect(found.status).toBe(200);
    expect(mocks.readableNotify).toHaveBeenCalledWith({ oid: "owner" }, ID, 2);
    expect(gone.status).toBe(404);
    expect(bad.status).toBe(404);
    expect(mocks.readableNotify).toHaveBeenCalledTimes(2);
  });

  it("should save the owner's draft as their version", async () => {
    mocks.notifyAccess.mockResolvedValue("owner");
    mocks.writeUserNotify.mockResolvedValue({ version: 4, revision: 0, amended: false });

    const response = await call(save as Handler, {}, SAVE);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ version: 4, revision: 0, amended: false });
    expect(mocks.writeUserNotify).toHaveBeenCalledWith(
      {},
      { conversationId: ID, editorOid: "owner", subject: "Claim", body: "Dear ((name))", data: { name: "Ada" }, baseVersion: 3, baseRevision: 0 }
    );
  });

  it("should refuse a reader with 403 and anyone else with 404, writing nothing", async () => {
    mocks.notifyAccess.mockResolvedValueOnce("reader").mockResolvedValueOnce(undefined);

    expect((await call(save as Handler, {}, SAVE)).status).toBe(403);
    expect((await call(save as Handler, {}, SAVE)).status).toBe(404);
    expect(mocks.writeUserNotify).not.toHaveBeenCalled();
  });

  it("should refuse a body the checks refuse with 400, and answer a stale base as the store's 409", async () => {
    mocks.notifyAccess.mockResolvedValue("owner");
    mocks.writeUserNotify.mockRejectedValue(new HttpError(409, "the Notify template has changed since that version", { current: TEMPLATE }));

    const bad = await call(save as Handler, {}, { ...SAVE, base_version: 0 });
    const stale = await call(save as Handler, {}, SAVE);

    expect(bad.status).toBe(400);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "the Notify template has changed since that version", current: TEMPLATE });
  });
});
