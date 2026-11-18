import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  viewerFrom: vi.fn(),
  readableDocmosis: vi.fn(),
  docmosisVersions: vi.fn(),
  docmosisPdf: vi.fn()
}));

vi.mock("@/viewer/identity", () => ({ viewerFrom: mocks.viewerFrom }));
vi.mock("@/web/data", () => ({ readableDocmosis: mocks.readableDocmosis, docmosisVersions: mocks.docmosisVersions, docmosisPdf: mocks.docmosisPdf }));

import { GET as getLatest } from "./route";
import { GET as getPdf } from "./versions/[version]/pdf/route";
import { GET as getVersion } from "./versions/[version]/route";
import { GET as getVersions } from "./versions/route";

const ID = "c1";
const ITEM = "d1";
const TEMPLATE = { version: 3, name: "Claim" };

function call(handler: (request: NextRequest, context: { params: Promise<never> }) => Promise<Response>, params: Record<string, string>): Promise<Response> {
  return handler(new NextRequest("http://hub/api/ui/assistant/docmosis/x"), {
    params: Promise.resolve({ conversationId: ID, itemId: ITEM, ...params }) as Promise<never>
  });
}

describe("the template read routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.viewerFrom.mockResolvedValue({ oid: "owner" });
  });

  it.each([
    ["latest", getLatest],
    ["versions", getVersions],
    ["version", getVersion],
    ["pdf", getPdf]
  ])("should answer 401 for the %s route when nobody is signed in", async (_label, handler) => {
    mocks.viewerFrom.mockResolvedValue(undefined);
    expect((await call(handler, { version: "1" })).status).toBe(401);
  });

  describe("latest", () => {
    it("should return the template with no-store", async () => {
      mocks.readableDocmosis.mockResolvedValue(TEMPLATE);
      const response = await call(getLatest, {});
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(TEMPLATE);
      expect(mocks.readableDocmosis).toHaveBeenCalledWith({ oid: "owner" }, ID, ITEM);
    });

    it("should answer 404 when there is nothing the viewer may read", async () => {
      mocks.readableDocmosis.mockResolvedValue(undefined);
      expect((await call(getLatest, {})).status).toBe(404);
    });
  });

  describe("versions", () => {
    it("should wrap the versions in an object", async () => {
      mocks.docmosisVersions.mockResolvedValue([{ version: 3 }]);
      const response = await call(getVersions, {});
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ versions: [{ version: 3 }] });
    });

    it("should answer 404 when there are none the viewer may read", async () => {
      mocks.docmosisVersions.mockResolvedValue(undefined);
      expect((await call(getVersions, {})).status).toBe(404);
    });
  });

  describe("version", () => {
    it("should return that version", async () => {
      mocks.readableDocmosis.mockResolvedValue(TEMPLATE);
      expect(await (await call(getVersion, { version: "2" })).json()).toEqual(TEMPLATE);
      expect(mocks.readableDocmosis).toHaveBeenCalledWith({ oid: "owner" }, ID, ITEM, 2);
    });

    it.each([["0"], ["abc"], ["-1"]])("should answer 404 for the version %s without reading", async (version) => {
      expect((await call(getVersion, { version })).status).toBe(404);
      expect(mocks.readableDocmosis).not.toHaveBeenCalled();
    });

    it("should answer 404 when the version is not kept", async () => {
      mocks.readableDocmosis.mockResolvedValue(undefined);
      expect((await call(getVersion, { version: "2" })).status).toBe(404);
    });
  });

  describe("pdf", () => {
    it("should return the PDF inline with a filename from the template's name and version", async () => {
      mocks.docmosisPdf.mockResolvedValue({ name: "Claim form", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) });
      const response = await call(getPdf, { version: "4" });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/pdf");
      expect(response.headers.get("content-length")).toBe("4");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-disposition")).toContain('inline; filename="Claim form-v4.pdf"');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    });

    it("should keep a non-ASCII name out of the plain filename", async () => {
      mocks.docmosisPdf.mockResolvedValue({ name: 'Ffurflen "Ŵ"', bytes: new Uint8Array([1]) });
      const disposition = (await call(getPdf, { version: "1" })).headers.get("content-disposition") ?? "";
      expect(disposition).toMatch(/^inline; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
      expect(disposition).toContain("filename*=UTF-8''");
    });

    it("should answer 404 for a malformed version and for a missing PDF", async () => {
      expect((await call(getPdf, { version: "x" })).status).toBe(404);
      mocks.docmosisPdf.mockResolvedValue(undefined);
      expect((await call(getPdf, { version: "1" })).status).toBe(404);
    });
  });
});
