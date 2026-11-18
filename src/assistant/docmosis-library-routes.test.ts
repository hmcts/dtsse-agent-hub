import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../agent-api/http.ts";
import { MAX_INDEX_BYTES } from "./docmosis-library.ts";

const store = vi.hoisted(() => ({ answerIndex: vi.fn() }));
const VIRTUAL_AGENT = { id: "va-1", ownerOid: "oid-a" };

vi.mock("@/store/prisma", () => ({ prisma: {} }));
vi.mock("@/agent-api/route", () => ({
  virtualRoute: (handler: (request: unknown) => Promise<Response>) => (request: Request, context: { params: Promise<unknown> }) =>
    context.params.then((params) => handler({ virtualAgent: VIRTUAL_AGENT, request, params }))
}));
vi.mock("@/assistant/docmosis-library-store", () => store);

const route = await import("../app/api/virtual/[virtualAgentId]/docmosis-library/[requestId]/route.ts");

const REQUEST_ID = "0f8a6a1e-1234-4000-8000-0000000000c1";
const params = { params: Promise.resolve({ virtualAgentId: "va-1", requestId: REQUEST_ID }) };
const put = (body: BodyInit) => new Request("http://localhost/x", { method: "PUT", body, headers: { "content-type": "application/json" } });
const SHA = "a".repeat(40);

async function refusal(call: Promise<unknown>): Promise<HttpError> {
  const error = await call.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

beforeEach(() => vi.resetAllMocks());

describe("PUT /api/virtual/{id}/docmosis-library/{request_id}", () => {
  it("should hand a valid index to the store and answer 204", async () => {
    const body = { commit: SHA, etag: '"e"', entries: [["Templates/a.docx", SHA, 3]] };

    const response = await route.PUT(put(JSON.stringify(body)), params);

    expect(response.status).toBe(204);
    expect(store.answerIndex).toHaveBeenCalledWith(expect.anything(), VIRTUAL_AGENT, REQUEST_ID, body);
  });

  it("should take an answer larger than the 256 KiB other bodies are held to", async () => {
    const entries = Array.from({ length: 3000 }, (_, i) => [`Templates/Base/${"x".repeat(80)}-${i}.docx`, SHA, i]);
    const text = JSON.stringify({ commit: SHA, etag: null, entries });

    const response = await route.PUT(put(text), params);

    expect(text.length).toBeGreaterThan(256 * 1024);
    expect(response.status).toBe(204);
  });

  it("should answer 413 for a body over 1 MiB, and pass nothing on", async () => {
    const error = await refusal(route.PUT(put(" ".repeat(MAX_INDEX_BYTES + 1)), params));

    expect(error.status).toBe(413);
    expect(error.message).toContain(String(MAX_INDEX_BYTES));
    expect(store.answerIndex).not.toHaveBeenCalled();
  });

  it("should answer 400 for a body that is not JSON, or not UTF-8", async () => {
    expect((await refusal(route.PUT(put("{"), params))).status).toBe(400);
    expect((await refusal(route.PUT(put(new Uint8Array([0x7b, 0xff, 0x7d])), params))).status).toBe(400);
    expect(store.answerIndex).not.toHaveBeenCalled();
  });

  it("should answer 400 naming the field for a body that is none of the answers", async () => {
    const error = await refusal(route.PUT(put(JSON.stringify({ commit: SHA, etag: null, entries: [["Templates/a.docx", "x", 1]] })), params));

    expect(error.status).toBe(400);
    expect(store.answerIndex).not.toHaveBeenCalled();
  });

  it("should let the store's refusal through", async () => {
    store.answerIndex.mockRejectedValue(new HttpError(400, "entries.0: is not a .docx under Templates/"));

    const error = await refusal(route.PUT(put(JSON.stringify({ commit: SHA, etag: null, entries: [["Other/a.docx", SHA, 1]] })), params));

    expect(error.status).toBe(400);
  });
});
