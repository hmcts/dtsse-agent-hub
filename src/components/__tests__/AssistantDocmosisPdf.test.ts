/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getDocument = vi.fn();

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: (options: unknown) => getDocument(options)
}));

import { drawPdf } from "@/components/assistant/docmosis-pdf";

interface Fake {
  destroy: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  options: { data: Uint8Array } | null;
}

/** A document of `pages` pages whose pages draw by `draw`, and what was done to it. */
function document_(pages: number, draw: () => Promise<void> = async () => undefined): Fake {
  const fake: Fake = { destroy: vi.fn(async () => undefined), cancel: vi.fn(), render: vi.fn(), options: null };
  fake.render.mockImplementation(() => ({ promise: draw(), cancel: fake.cancel }));
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale }),
    render: fake.render
  };
  const task = { promise: Promise.resolve({ numPages: pages, getPage: async () => page }), destroy: fake.destroy };
  getDocument.mockImplementation((options: { data: Uint8Array }) => {
    fake.options = options;
    return task;
  });
  return fake;
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
});

afterEach(() => {
  vi.restoreAllMocks();
  getDocument.mockReset();
});

describe("drawPdf", () => {
  it("should draw each page as a canvas of the width asked for, labelled with its place", async () => {
    document_(2);
    const canvases = await drawPdf(new Uint8Array([1, 2, 3]).buffer, 300, new AbortController().signal);
    expect(canvases).toHaveLength(2);
    expect(canvases[0]?.style.width).toBe("300px");
    expect(canvases[0]?.style.height).toBe("600px");
    expect(canvases[1]?.getAttribute("aria-label")).toBe("Page 2 of 2");
  });

  it("should hand pdf.js a copy, so the caller's bytes survive for a repaint", async () => {
    const fake = document_(1);
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    await drawPdf(bytes, 300, new AbortController().signal);
    expect(fake.options?.data.buffer).not.toBe(bytes);
    expect(Array.from(fake.options?.data ?? [])).toEqual([1, 2, 3]);
    expect(bytes.byteLength).toBe(3);
  });

  it("should leave a page unpainted when it has no 2d context, and still release the document", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const fake = document_(1);
    const canvases = await drawPdf(new ArrayBuffer(1), 300, new AbortController().signal);
    expect(canvases).toHaveLength(1);
    expect(fake.render).not.toHaveBeenCalled();
    expect(fake.destroy).toHaveBeenCalled();
  });

  it("should cancel the page being drawn and destroy the document when aborted mid-render", async () => {
    const controller = new AbortController();
    let fail: (reason: Error) => void = () => undefined;
    const fake = document_(3, () => new Promise<void>((_resolve, reject) => (fail = reject)));
    const drawing = drawPdf(new ArrayBuffer(1), 300, controller.signal);
    await vi.waitFor(() => expect(fake.render).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(fake.cancel).toHaveBeenCalledTimes(1);
    expect(fake.destroy).toHaveBeenCalled();
    fail(new Error("RenderingCancelledException"));
    await expect(drawing).resolves.toEqual([]);
  });

  it("should stop between pages when aborted", async () => {
    const controller = new AbortController();
    const fake = document_(3, async () => controller.abort());
    const canvases = await drawPdf(new ArrayBuffer(1), 300, controller.signal);
    expect(canvases).toHaveLength(1);
    expect(fake.render).toHaveBeenCalledTimes(1);
  });

  it("should not open the document at all when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    document_(1);
    await expect(drawPdf(new ArrayBuffer(1), 300, controller.signal)).resolves.toEqual([]);
    expect(getDocument).not.toHaveBeenCalled();
  });

  it("should pass on a failure to read the document that is not an abort", async () => {
    getDocument.mockReturnValue({ promise: Promise.reject(new Error("InvalidPDFException")), destroy: vi.fn() });
    await expect(drawPdf(new ArrayBuffer(1), 300, new AbortController().signal)).rejects.toThrow("InvalidPDFException");
  });
});
