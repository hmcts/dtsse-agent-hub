import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../agent-api/http.ts";

const store = vi.hoisted(() => ({
  docmosisView: vi.fn(),
  writeAgentDocmosis: vi.fn(),
  putDocmosisAsset: vi.fn(),
  readDocmosisDocx: vi.fn(),
  putDocmosisPdf: vi.fn()
}));

vi.mock("@/store/prisma", () => ({ prisma: {} }));
vi.mock("@/agent-api/route", () => ({
  ownedAgentRoute: (handler: (request: unknown) => Promise<Response>) => (request: Request, context: { params: Promise<unknown> }) =>
    context.params.then((params) => handler({ agent: { id: "agent-1" }, request, params }))
}));
vi.mock("@/assistant/conversation-store", () => ({ requireConversationOfAgent: async () => ({ id: "conv-1" }) }));
vi.mock("@/assistant/docmosis-store", () => store);

const assets = await import("../app/api/agent/[agentId]/docmosis/assets/[sha256]/route.ts");
const root = await import("../app/api/agent/[agentId]/docmosis/route.ts");
const pdf = await import("../app/api/agent/[agentId]/docmosis/versions/[version]/pdf/route.ts");

const params = <P>(value: P) => ({ params: Promise.resolve(value) });
const hex = async (bytes: Uint8Array) => Buffer.from(await crypto.subtle.digest("SHA-256", bytes.slice())).toString("hex");
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
const PDF = new TextEncoder().encode("%PDF-1.7 body");
const SHA = "a".repeat(64);

const bodyOf = (overrides: Record<string, unknown> = {}) => ({
  name: "Claim",
  docx: `sha256:${SHA}`,
  schema: { root: { kind: "object", controls: [], notes: [], properties: {} }, warnings: [] },
  data: {},
  base_version: 0,
  ...overrides
});

const request = (method: string, body?: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://localhost/x", { method, ...(body === undefined ? {} : { body }), headers });

async function refusal(call: Promise<unknown>): Promise<HttpError> {
  const error = await call.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

beforeEach(() => vi.resetAllMocks());

describe("PUT /api/agent/{id}/docmosis/assets/{sha256}", () => {
  it("should store a .docx under its digest and answer the reference", async () => {
    const sha = await hex(DOCX);

    const response = await assets.PUT(request("PUT", DOCX.slice()), params({ agentId: "agent-1", sha256: sha }));

    expect(await response.json()).toEqual({ asset: `sha256:${sha}` });
    expect(store.putDocmosisAsset).toHaveBeenCalledWith(expect.anything(), "conv-1", sha, expect.any(Uint8Array));
  });

  it("should refuse a path that is not a digest, bytes that are not a zip, and a digest that is not the bytes'", async () => {
    expect((await refusal(assets.PUT(request("PUT", DOCX.slice()), params({ agentId: "a", sha256: "xyz" })))).status).toBe(400);
    expect((await refusal(assets.PUT(request("PUT", new Uint8Array([1, 2, 3])), params({ agentId: "a", sha256: SHA })))).status).toBe(400);
    expect((await refusal(assets.PUT(request("PUT", DOCX.slice()), params({ agentId: "a", sha256: SHA })))).status).toBe(400);
    expect(store.putDocmosisAsset).not.toHaveBeenCalled();
  });

  it("should answer 413 for a body over 5 MiB", async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);

    const error = await refusal(assets.PUT(request("PUT", big), params({ agentId: "a", sha256: SHA })));

    expect(error.status).toBe(413);
    expect(error.message).toContain("5242880");
  });

  it("should read a held .docx back, and 404 for one the conversation does not hold", async () => {
    store.readDocmosisDocx.mockResolvedValueOnce(DOCX).mockResolvedValueOnce(null);

    const found = await assets.GET(request("GET"), params({ agentId: "a", sha256: SHA }));
    expect(new Uint8Array(await found.arrayBuffer())).toEqual(DOCX);
    expect(found.headers.get("content-type")).toBe("application/octet-stream");

    expect((await refusal(assets.GET(request("GET"), params({ agentId: "a", sha256: SHA })))).status).toBe(404);
  });
});

describe("PUT /api/agent/{id}/docmosis", () => {
  it("should write the version and answer it", async () => {
    store.writeAgentDocmosis.mockResolvedValue({ version: 1, revision: 0 });

    const response = await root.PUT(request("PUT", JSON.stringify(bodyOf({ summary: "First" }))), params({ agentId: "a" }));

    expect(await response.json()).toEqual({ version: 1, revision: 0 });
    expect(store.writeAgentDocmosis).toHaveBeenCalledWith(expect.anything(), {
      conversationId: "conv-1",
      body: expect.objectContaining({ name: "Claim", summary: "First" })
    });
  });

  it("should answer 400 naming the field when the body is refused, and write nothing", async () => {
    const error = await refusal(root.PUT(request("PUT", JSON.stringify(bodyOf({ docx: "nope" }))), params({ agentId: "a" })));

    expect(error.status).toBe(400);
    expect(error.message).toMatch(/^docx /);
    expect(store.writeAgentDocmosis).not.toHaveBeenCalled();
  });

  it("should let the store's conflict through", async () => {
    store.writeAgentDocmosis.mockRejectedValue(new HttpError(409, "changed", { current: null }));

    expect((await refusal(root.PUT(request("PUT", JSON.stringify(bodyOf())), params({ agentId: "a" })))).status).toBe(409);
  });
});

describe("GET /api/agent/{id}/docmosis", () => {
  it("should read the latest version, or the kept one asked for", async () => {
    store.docmosisView.mockResolvedValue({ version: 2 });

    const latest = await root.GET(new Request("http://localhost/x"), params({ agentId: "a" }));
    const asked = await root.GET(new Request("http://localhost/x?version=1"), params({ agentId: "a" }));

    expect(await latest.json()).toEqual({ version: 2 });
    expect(await asked.json()).toEqual({ version: 2 });
    expect(store.docmosisView.mock.calls.map((call) => call[2])).toEqual([undefined, 1]);
  });

  it("should answer 400 for a version that is not a whole number and 404 for none held", async () => {
    expect((await refusal(root.GET(new Request("http://localhost/x?version=abc"), params({ agentId: "a" })))).status).toBe(400);
    store.docmosisView.mockResolvedValue(null);
    expect((await refusal(root.GET(new Request("http://localhost/x"), params({ agentId: "a" })))).status).toBe(404);
    expect((await refusal(root.GET(new Request("http://localhost/x?version=4"), params({ agentId: "a" })))).message).toContain("version 4");
  });
});

describe("PUT /api/agent/{id}/docmosis/versions/{version}/pdf", () => {
  it("should store the PDF and answer 204", async () => {
    store.putDocmosisPdf.mockResolvedValue(true);

    const response = await pdf.PUT(request("PUT", PDF.slice()), params({ agentId: "a", version: "3" }));

    expect(response.status).toBe(204);
    expect(store.putDocmosisPdf).toHaveBeenCalledWith(expect.anything(), "conv-1", 3, expect.any(Uint8Array));
  });

  it("should refuse a version that is not a number, bytes that are not a PDF, and one over 5 MiB", async () => {
    expect((await refusal(pdf.PUT(request("PUT", PDF.slice()), params({ agentId: "a", version: "0" })))).status).toBe(400);
    expect((await refusal(pdf.PUT(request("PUT", DOCX.slice()), params({ agentId: "a", version: "1" })))).status).toBe(400);
    expect((await refusal(pdf.PUT(request("PUT", new Uint8Array(5 * 1024 * 1024 + 1)), params({ agentId: "a", version: "1" })))).status).toBe(413);
  });

  it("should answer 404 for a version that does not keep a PDF", async () => {
    store.putDocmosisPdf.mockResolvedValue(false);

    expect((await refusal(pdf.PUT(request("PUT", PDF.slice()), params({ agentId: "a", version: "9" })))).status).toBe(404);
  });
});
