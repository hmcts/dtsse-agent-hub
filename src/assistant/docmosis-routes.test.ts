import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../agent-api/http.ts";

const store = vi.hoisted(() => ({
  docmosisView: vi.fn(),
  writeAgentDocmosis: vi.fn(),
  putDocmosisAsset: vi.fn(),
  readDocmosisDocx: vi.fn(),
  putDocmosisPdf: vi.fn(),
  listDocmosisSummaries: vi.fn(),
  docmosisSummaryJson: vi.fn((summary: unknown) => summary),
  removeDocmosisTemplate: vi.fn()
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
const list = await import("../app/api/agent/[agentId]/docmosis-templates/route.ts");
const one = await import("../app/api/agent/[agentId]/docmosis-templates/[itemId]/route.ts");
const onePdf = await import("../app/api/agent/[agentId]/docmosis-templates/[itemId]/versions/[version]/pdf/route.ts");

const ITEM = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

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

beforeEach(() => {
  vi.resetAllMocks();
  store.docmosisSummaryJson.mockImplementation((summary: unknown) => summary);
});

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
  it("should write the version through the agent asked for and answer it when the body is valid", async () => {
    store.writeAgentDocmosis.mockResolvedValue({ id: ITEM, version: 1, revision: 0 });

    const response = await root.PUT(request("PUT", JSON.stringify(bodyOf({ summary: "First" }))), params({ agentId: "a" }));

    expect(await response.json()).toEqual({ version: 1, revision: 0 });
    expect(store.writeAgentDocmosis).toHaveBeenCalledWith(expect.anything(), {
      conversationId: "conv-1",
      body: expect.objectContaining({ name: "Claim", summary: "First" }),
      agent: expect.objectContaining({ id: "agent-1" })
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
    expect(store.docmosisView.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      [undefined, undefined],
      [undefined, 1]
    ]);
  });

  it("should answer 400 for a version that is not a whole number and 404 for none held", async () => {
    expect((await refusal(root.GET(new Request("http://localhost/x?version=abc"), params({ agentId: "a" })))).status).toBe(400);
    store.docmosisView.mockResolvedValue(null);
    expect((await refusal(root.GET(new Request("http://localhost/x"), params({ agentId: "a" })))).status).toBe(404);
    expect((await refusal(root.GET(new Request("http://localhost/x?version=4"), params({ agentId: "a" })))).message).toContain("version 4");
  });
});

const pdfRequest = (body: BodyInit, query = "?revision=2") => new Request(`http://localhost/x${query}`, { method: "PUT", body });

describe("PUT /api/agent/{id}/docmosis/versions/{version}/pdf", () => {
  it("should store the PDF and answer 204", async () => {
    store.putDocmosisPdf.mockResolvedValue("stored");

    const response = await pdf.PUT(pdfRequest(PDF.slice()), params({ agentId: "a", version: "3" }));

    expect(response.status).toBe(204);
    expect(store.putDocmosisPdf).toHaveBeenCalledWith(expect.anything(), "conv-1", undefined, 3, 2, expect.any(Uint8Array));
  });

  it("should refuse a version that is not a number, bytes that are not a PDF, and one over 5 MiB", async () => {
    expect((await refusal(pdf.PUT(pdfRequest(PDF.slice()), params({ agentId: "a", version: "0" })))).status).toBe(400);
    expect((await refusal(pdf.PUT(pdfRequest(DOCX.slice()), params({ agentId: "a", version: "1" })))).status).toBe(400);
    expect((await refusal(pdf.PUT(pdfRequest(new Uint8Array(5 * 1024 * 1024 + 1)), params({ agentId: "a", version: "1" })))).status).toBe(413);
  });

  it("should answer 404 for a version that does not keep a PDF", async () => {
    store.putDocmosisPdf.mockResolvedValue("gone");

    expect((await refusal(pdf.PUT(pdfRequest(PDF.slice()), params({ agentId: "a", version: "9" })))).status).toBe(404);
  });

  it("should answer 409 with the current version when the PDF was rendered at a revision the version has left", async () => {
    store.putDocmosisPdf.mockResolvedValue("stale");
    store.docmosisView.mockResolvedValue({ version: 3, revision: 3 });

    const error = await refusal(pdf.PUT(pdfRequest(PDF.slice()), params({ agentId: "a", version: "3" })));

    expect(error.status).toBe(409);
    expect(error.extra).toEqual({ current: { version: 3, revision: 3 } });
  });

  it.each(["", "?revision=", "?revision=-1", "?revision=x", "?revision=1.5"])("should answer 400 when the revision is %j", async (query) => {
    expect((await refusal(pdf.PUT(pdfRequest(PDF.slice(), query), params({ agentId: "a", version: "3" })))).status).toBe(400);
    expect(store.putDocmosisPdf).not.toHaveBeenCalled();
  });
});

describe("GET and POST /api/agent/{id}/docmosis-templates", () => {
  it("should list every template", async () => {
    store.listDocmosisSummaries.mockResolvedValue([{ id: ITEM, name: "Claim", version: 2 }]);

    const response = await list.GET(new Request("http://localhost/x"), params({ agentId: "a" }));

    expect(await response.json()).toEqual({ docmosis_templates: [{ id: ITEM, name: "Claim", version: 2 }] });
  });

  it("should make a new template whatever the conversation holds and answer 201 with its id", async () => {
    store.writeAgentDocmosis.mockResolvedValue({ id: ITEM, version: 1, revision: 0 });

    const response = await list.POST(request("POST", JSON.stringify(bodyOf())), params({ agentId: "a" }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: ITEM, version: 1, revision: 0 });
    expect(store.writeAgentDocmosis).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ conversationId: "conv-1", create: true }));
  });

  it("should answer 400 when a new template names a base version above 0, and write nothing", async () => {
    const response = await refusal(list.POST(request("POST", JSON.stringify(bodyOf({ base_version: 3 }))), params({ agentId: "a" })));

    expect(response.status).toBe(400);
    expect(store.writeAgentDocmosis).not.toHaveBeenCalled();
  });

  it("should answer 400 when the body to create is refused, and write nothing", async () => {
    expect((await refusal(list.POST(request("POST", JSON.stringify(bodyOf({ docx: "nope" }))), params({ agentId: "a" })))).status).toBe(400);
    expect(store.writeAgentDocmosis).not.toHaveBeenCalled();
  });
});

describe("/api/agent/{id}/docmosis-templates/{itemId}", () => {
  it("should read the template it names, with its id", async () => {
    store.docmosisView.mockResolvedValue({ version: 2 });

    const response = await one.GET(new Request("http://localhost/x?version=1"), params({ agentId: "a", itemId: ITEM }));

    expect(await response.json()).toEqual({ id: ITEM, version: 2 });
    expect(store.docmosisView).toHaveBeenCalledWith(expect.anything(), "conv-1", ITEM, 1);
  });

  it("should answer 404 for an id that is not a uuid and for a template the conversation does not hold", async () => {
    expect((await refusal(one.GET(new Request("http://localhost/x"), params({ agentId: "a", itemId: "nope" })))).status).toBe(404);
    store.docmosisView.mockResolvedValue(null);
    expect((await refusal(one.GET(new Request("http://localhost/x"), params({ agentId: "a", itemId: ITEM })))).status).toBe(404);
  });

  it("should write the template it names", async () => {
    store.writeAgentDocmosis.mockResolvedValue({ id: ITEM, version: 3, revision: 0 });

    const response = await one.PUT(request("PUT", JSON.stringify(bodyOf({ base_version: 2 }))), params({ agentId: "a", itemId: ITEM }));

    expect(await response.json()).toEqual({ version: 3, revision: 0 });
    expect(store.writeAgentDocmosis).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ conversationId: "conv-1", item: ITEM }));
  });

  it("should remove the template it names and answer 204", async () => {
    const response = await one.DELETE(request("DELETE"), params({ agentId: "a", itemId: ITEM }));

    expect(response.status).toBe(204);
    expect(store.removeDocmosisTemplate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "conv-1" }), ITEM);
  });

  it("should store the PDF of one of its versions", async () => {
    store.putDocmosisPdf.mockResolvedValue("stored");

    const response = await onePdf.PUT(pdfRequest(PDF.slice()), params({ agentId: "a", itemId: ITEM, version: "3" }));

    expect(response.status).toBe(204);
    expect(store.putDocmosisPdf).toHaveBeenCalledWith(expect.anything(), "conv-1", ITEM, 3, 2, expect.any(Uint8Array));
  });
});
