import type * as PdfJs from "pdfjs-dist";

let library: Promise<typeof PdfJs> | null = null;

/**
 * pdf.js, loaded on first use because it touches `DOMMatrix` and the like as it loads, which the server render of the
 * page has none of. Its worker is the library's own file, which the bundler emits under the hub's `/_next/static`, so
 * nothing is fetched from another origin and the page's framing policy is untouched.
 */
function pdfjs(): Promise<typeof PdfJs> {
  library ??= import("pdfjs-dist").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    return lib;
  });
  return library;
}

/**
 * Every page of a PDF drawn as a canvas that is `width` CSS pixels across. Aborting stops the page being drawn,
 * releases the document and resolves with nothing.
 */
export async function drawPdf(bytes: ArrayBuffer, width: number, signal: AbortSignal): Promise<HTMLCanvasElement[]> {
  const lib = await pdfjs();
  if (signal.aborted) {
    return [];
  }
  // pdf.js takes ownership of the buffer it is given, which would leave the caller's bytes empty for the next repaint.
  const task = lib.getDocument({ data: new Uint8Array(bytes.slice(0)) });
  let drawing: PdfJs.RenderTask | null = null;
  const stop = () => {
    drawing?.cancel();
    void task.destroy();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const doc = await task.promise;
    const canvases: HTMLCanvasElement[] = [];
    const ratio = window.devicePixelRatio || 1;
    for (let number = 1; number <= doc.numPages; number++) {
      if (signal.aborted) {
        break;
      }
      const page = await doc.getPage(number);
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (width / natural.width) * ratio });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `Page ${number} of ${doc.numPages}`);
      const context = canvas.getContext("2d");
      if (context !== null) {
        drawing = page.render({ canvas, canvasContext: context, viewport });
        await drawing.promise;
        drawing = null;
      }
      canvases.push(canvas);
    }
    return canvases;
  } catch (error) {
    if (signal.aborted) {
      return [];
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", stop);
    void task.destroy();
  }
}
