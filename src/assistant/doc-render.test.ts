import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderTemplate } from "./doc-render.ts";

const PDF = new TextEncoder().encode("%PDF-1.7 body");
const DOCX = new Uint8Array([0x50, 0x4b, 3, 4]);

function reply(body: BodyInit | null, init: ResponseInit): Response {
  return new Response(body, init);
}

describe("renderTemplate", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("DOC_RENDER_URL", "");
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("should post the template, data and output format to the default service and return the PDF", async () => {
    fetchMock.mockResolvedValue(reply(PDF, { status: 200 }));
    const result = await renderTemplate({ docx: DOCX, data: { a: 1 }, name: "Claim form" });
    expect(result).toEqual({ ok: true, pdf: PDF });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://doc-render.aat.platform.hmcts.net/api/render");
    const form = (init as RequestInit).body as FormData;
    expect((form.get("templateFile") as File).name).toBe("Claim form.docx");
    expect(await (form.get("data") as Blob).text()).toBe('{"a":1}');
    expect((form.get("data") as Blob).type).toBe("application/json");
    expect(form.get("outputFormat")).toBe("pdf");
  });

  it("should read DOC_RENDER_URL on each call and ignore a trailing slash", async () => {
    fetchMock.mockResolvedValue(reply(PDF, { status: 200 }));
    vi.stubEnv("DOC_RENDER_URL", "http://render.local:8080/");
    await renderTemplate({ docx: DOCX, data: {}, name: "x" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://render.local:8080/api/render");
  });

  it("should pass the caller's signal alongside its own timeout", async () => {
    fetchMock.mockResolvedValue(reply(PDF, { status: 200 }));
    const controller = new AbortController();
    await renderTemplate({ docx: DOCX, data: {}, name: "x", signal: controller.signal });
    const { signal } = fetchMock.mock.calls[0]?.[1] ?? {};
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("should return the short and long messages when the service refuses the merge", async () => {
    fetchMock.mockResolvedValue(reply(JSON.stringify({ succeeded: false, shortMsg: "bad tag", longMsg: "bad tag at line 3" }), { status: 400 }));
    expect(await renderTemplate({ docx: DOCX, data: {}, name: "x" })).toEqual({ ok: false, kind: "merge", short: "bad tag", long: "bad tag at line 3" });
  });

  it("should use the short message as the long one when the service sends none", async () => {
    fetchMock.mockResolvedValue(reply(JSON.stringify({ shortMsg: "bad tag" }), { status: 400 }));
    expect(await renderTemplate({ docx: DOCX, data: {}, name: "x" })).toEqual({ ok: false, kind: "merge", short: "bad tag", long: "bad tag" });
  });

  it("should call the service unreachable when a 400 carries no message", async () => {
    fetchMock.mockResolvedValue(reply("not json", { status: 400 }));
    expect(await renderTemplate({ docx: DOCX, data: {}, name: "x" })).toEqual({ ok: false, kind: "unreachable", message: "doc-render answered 400" });
  });

  it("should report busy with the Retry-After seconds on a 503", async () => {
    fetchMock.mockResolvedValue(reply("", { status: 503, headers: { "retry-after": "7" } }));
    expect(await renderTemplate({ docx: DOCX, data: {}, name: "x" })).toEqual({ ok: false, kind: "busy", retryAfter: 7 });
  });

  it.each([[null], ["soon"], ["0"]])("should default the retry delay to 5 seconds when Retry-After is %s", async (header) => {
    fetchMock.mockResolvedValue(reply("", { status: 503, headers: header === null ? {} : { "retry-after": header } }));
    expect(await renderTemplate({ docx: DOCX, data: {}, name: "x" })).toEqual({ ok: false, kind: "busy", retryAfter: 5 });
  });

  it("should call the service unreachable on any other failure status", async () => {
    fetchMock.mockResolvedValue(reply("boom", { status: 500 }));
    expect(await renderTemplate({ docx: DOCX, data: {}, name: "x" })).toEqual({ ok: false, kind: "unreachable", message: "doc-render answered 500" });
  });

  it("should call the service unreachable when a 200 is not a PDF", async () => {
    fetchMock.mockResolvedValue(reply("<html>", { status: 200 }));
    expect(await renderTemplate({ docx: DOCX, data: {}, name: "x" })).toEqual({
      ok: false,
      kind: "unreachable",
      message: "doc-render did not answer with a PDF"
    });
  });

  it("should refuse a PDF over 5 MiB, by its content-length or by its bytes, as a merge error", async () => {
    const over = 5 * 1024 * 1024 + 1;
    fetchMock.mockResolvedValueOnce(reply(PDF, { status: 200, headers: { "content-length": String(over) } }));
    fetchMock.mockResolvedValueOnce(reply(new Uint8Array(over), { status: 200 }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await renderTemplate({ docx: DOCX, data: {}, name: "x" })).toMatchObject({
        ok: false,
        kind: "merge",
        short: "The rendered PDF is larger than 5 MiB"
      });
    }
  });

  it("should call the service unreachable when the request fails", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await renderTemplate({ docx: DOCX, data: {}, name: "x" })).toEqual({ ok: false, kind: "unreachable", message: "fetch failed" });
  });

  it("should stringify a failure that is not an Error", async () => {
    fetchMock.mockRejectedValue("nope");
    expect(await renderTemplate({ docx: DOCX, data: {}, name: "x" })).toEqual({ ok: false, kind: "unreachable", message: "nope" });
  });

  it("should call the service unreachable when it does not answer within the timeout", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => (init as RequestInit).signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError"))))
    );
    const pending = renderTemplate({ docx: DOCX, data: {}, name: "x" });
    timeout.abort();
    expect(await pending).toEqual({ ok: false, kind: "unreachable", message: "doc-render did not answer in time" });
  });
});
