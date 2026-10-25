/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_UPLOAD_BYTES, PART_BYTES } from "@/assistant/uploads";
import {
  admitFiles,
  createUpload,
  discardUpload,
  fileSizeLabel,
  partRanges,
  pastedName,
  putPart,
  refusalIn,
  UploadAborted,
  uploadFile
} from "./uploadClient.ts";

/**
 * A stand-in for the browser's `XMLHttpRequest`. `hold` leaves a request in flight so a test can abort it; otherwise
 * each send reports its progress and finishes on the next microtask, which is what lets the part loop run.
 */
class FakeRequest {
  static made: FakeRequest[] = [];
  static hold = false;
  static status = 200;
  static body = "";
  static failWith: "error" | "timeout" | null = null;
  method = "";
  url = "";
  status = 0;
  responseText = "";
  payload: Blob | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(): void {
    return;
  }

  send(payload: Blob): void {
    this.payload = payload;
    FakeRequest.made.push(this);
    if (!FakeRequest.hold) {
      queueMicrotask(() => this.finish());
    }
  }

  finish(): void {
    if (FakeRequest.failWith === "error") {
      this.onerror?.();
      return;
    }
    if (FakeRequest.failWith === "timeout") {
      this.ontimeout?.();
      return;
    }
    this.upload.onprogress?.({ loaded: this.payload?.size ?? 0 } as ProgressEvent);
    this.status = FakeRequest.status;
    this.responseText = FakeRequest.body;
    this.onload?.();
  }

  abort(): void {
    this.onabort?.();
  }
}

function answers(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const call = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", call);
  return call;
}

function body(size: number): Blob {
  return new Blob([new Uint8Array(size)]);
}

beforeEach(() => {
  FakeRequest.made = [];
  FakeRequest.hold = false;
  FakeRequest.status = 200;
  FakeRequest.body = "";
  FakeRequest.failWith = null;
  vi.stubGlobal("XMLHttpRequest", FakeRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fileSizeLabel", () => {
  it("should count in bytes when the file is tiny", () => {
    expect(fileSizeLabel(0)).toBe("0 bytes");
    expect(fileSizeLabel(1)).toBe("1 byte");
    expect(fileSizeLabel(900)).toBe("900 bytes");
  });

  it("should count in kilobytes when the file is under a megabyte", () => {
    expect(fileSizeLabel(2048)).toBe("2 KB");
    expect(fileSizeLabel(512 * 1024)).toBe("512 KB");
  });

  it("should count in megabytes when the file is larger", () => {
    expect(fileSizeLabel(1024 * 1024)).toBe("1.0 MB");
    expect(fileSizeLabel(MAX_UPLOAD_BYTES)).toBe("25.0 MB");
  });
});

describe("admitFiles", () => {
  it("should accept the files when they are within both caps", () => {
    const chosen = [
      { name: "a.pdf", size: 10 },
      { name: "b.png", size: 20 }
    ];

    expect(admitFiles(0, chosen)).toEqual({ accepted: chosen, refusal: null });
  });

  it("should refuse the whole batch and name the limit when it would be more than four files", () => {
    const result = admitFiles(3, [
      { name: "a.pdf", size: 10 },
      { name: "b.pdf", size: 10 }
    ]);

    expect(result.accepted).toEqual([]);
    expect(result.refusal).toBe("You can attach up to 4 files to a message.");
  });

  it("should refuse an over-size file by name and name the limit, keeping the others", () => {
    const result = admitFiles(0, [
      { name: "huge.zip", size: MAX_UPLOAD_BYTES + 1 },
      { name: "fine.pdf", size: 10 }
    ]);

    expect(result.accepted).toEqual([{ name: "fine.pdf", size: 10 }]);
    expect(result.refusal).toBe("huge.zip is too big. Each file must be 25 MB or less.");
  });

  it("should name every over-size file when more than one is too big", () => {
    const result = admitFiles(0, [
      { name: "one.zip", size: MAX_UPLOAD_BYTES + 1 },
      { name: "two.zip", size: MAX_UPLOAD_BYTES + 1 },
      { name: "three.zip", size: MAX_UPLOAD_BYTES + 1 }
    ]);

    expect(result.refusal).toBe("one.zip, two.zip and three.zip are too big. Each file must be 25 MB or less.");
  });

  it("should refuse an empty file when there is nothing in it to send", () => {
    const result = admitFiles(0, [
      { name: "nothing.txt", size: 0 },
      { name: "also-nothing.txt", size: 0 }
    ]);

    expect(result.accepted).toEqual([]);
    expect(result.refusal).toBe("nothing.txt and also-nothing.txt are empty, so there is nothing to attach.");
  });

  it("should say both when a batch has an over-size file and an empty one", () => {
    const result = admitFiles(0, [
      { name: "huge.zip", size: MAX_UPLOAD_BYTES + 1 },
      { name: "nothing.txt", size: 0 }
    ]);

    expect(result.refusal).toBe("huge.zip is too big. Each file must be 25 MB or less. nothing.txt is empty, so there is nothing to attach.");
  });
});

describe("partRanges", () => {
  it("should cut the largest allowed file into parts at the right offsets when the parts are 4 MiB", () => {
    const ranges = partRanges(MAX_UPLOAD_BYTES, PART_BYTES);

    expect(ranges).toHaveLength(7);
    expect(ranges[0]).toEqual({ index: 0, start: 0, end: PART_BYTES });
    expect(ranges[6]).toEqual({ index: 6, start: 6 * PART_BYTES, end: MAX_UPLOAD_BYTES });
    expect(ranges.every((range, index) => range.index === index)).toBe(true);
  });

  it("should make one part per whole part when the size divides exactly", () => {
    expect(partRanges(8, 4)).toEqual([
      { index: 0, start: 0, end: 4 },
      { index: 1, start: 4, end: 8 }
    ]);
  });

  it("should make a single short part when the file is smaller than one part", () => {
    expect(partRanges(3, 4)).toEqual([{ index: 0, start: 0, end: 3 }]);
  });

  it("should make no parts when there are no bytes", () => {
    expect(partRanges(0, 4)).toEqual([]);
  });
});

describe("pastedName", () => {
  it("should keep the name when the file has one", () => {
    expect(pastedName("letter.pdf", "application/pdf", new Date("2026-10-25T06:43:42Z"))).toBe("letter.pdf");
  });

  it("should name a nameless screenshot after the time it arrived when the clipboard gave no name", () => {
    expect(pastedName("", "image/png", new Date("2026-10-25T06:43:42Z"))).toBe("screenshot-2026-10-25-06-43-42.png");
  });

  it("should fall back to a plain extension when the media type is not a simple one", () => {
    expect(pastedName("  ", "", new Date("2026-10-25T06:43:42Z"))).toBe("screenshot-2026-10-25-06-43-42.bin");
  });
});

describe("refusalIn", () => {
  // Each of these is a refusal one of the routes really gives; the bodies are the shape `uiRefusals` renders, with
  // the reason the server sets beside its own sentence.
  it.each([
    ["unavailable", 404, "Attaching files is not switched on here yet."],
    ["no_such_conversation", 404, "This chat no longer exists, so the file could not be attached."],
    ["no_such_upload", 404, "This file is no longer being uploaded. Remove it and attach it again."],
    ["file_too_big", 400, "This file is too big. Each file must be 25 MB or less."],
    ["too_many_files", 409, "This message already has 4 files. Send it, then attach the rest to your next one."],
    ["conversation_full", 409, "This chat is full: its files can add up to 200 MB in total. Start a new chat to attach more."],
    ["part_too_big", 413, "Part of the file was rejected as too large. Remove it and attach it again."],
    ["part_wrong_length", 400, "The file changed while it was uploading. Remove it and attach it again."]
  ])("should word %s as a sentence of its own when the hub refuses with it", (reason, status, sentence) => {
    expect(refusalIn(JSON.stringify({ reason, error: "the contract's wording" }), `failed (${status})`)).toBe(sentence);
  });

  it("should tell the two caps apart, so being asked to send and being out of room never read the same", () => {
    const tooMany = refusalIn(JSON.stringify({ reason: "too_many_files", error: "a message carries at most 4 files" }), "failed");
    const full = refusalIn(JSON.stringify({ reason: "conversation_full", error: "this conversation's files add up to at most 200 MB" }), "failed");

    expect(tooMany).not.toBe(full);
    expect(tooMany).toContain("attach the rest to your next one");
    expect(full).toContain("Start a new chat");
  });

  it("should keep the hub's own sentence when the reason is one this module does not know", () => {
    expect(refusalIn(JSON.stringify({ reason: "something_new", error: "a rule nobody here has heard of" }), "failed")).toBe("a rule nobody here has heard of");
  });

  it("should fall back to the status when the body is not the hub's shape at all", () => {
    expect(refusalIn("<html>gateway</html>", "failed (502)")).toBe("failed (502)");
    expect(refusalIn("null", "failed (502)")).toBe("failed (502)");
    expect(refusalIn("{}", "failed (502)")).toBe("failed (502)");
  });
});

describe("createUpload", () => {
  // 201, which is what the route answers: `response.ok` is what this reads, so a stub that said 200 would have
  // passed against a route that never gives one.
  it("should post the file's details and return where to send it when the hub accepts", async () => {
    const call = answers({ uploadId: "u1", partBytes: PART_BYTES, parts: 1 }, 201);

    const created = await createUpload({ conversationId: "c1", name: "a.pdf", size: 10, mediaType: "application/pdf" });

    expect(created).toEqual({ uploadId: "u1", partBytes: PART_BYTES, parts: 1 });
    const [url, init] = call.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ui/uploads");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ conversationId: "c1", name: "a.pdf", size: 10, mediaType: "application/pdf" });
  });

  it("should give the hub's own sentence when it refuses the file for a reason this module has no wording for", async () => {
    answers({ error: "a file is at most 25 MB" }, 413);

    await expect(createUpload({ conversationId: "c1", name: "a.pdf", size: 10, mediaType: "application/pdf" })).rejects.toThrow("a file is at most 25 MB");
  });

  it("should name the status when the refusal is not the hub's usual shape", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>gateway</html>", { status: 502 }));

    await expect(createUpload({ conversationId: "c1", name: "a.pdf", size: 10, mediaType: "application/pdf" })).rejects.toThrow(
      "the file could not be attached (502)"
    );
  });

  it("should complain when the hub answers without an upload to send to", async () => {
    answers({ uploadId: "u1" });

    await expect(createUpload({ conversationId: "c1", name: "a.pdf", size: 10, mediaType: "application/pdf" })).rejects.toThrow(
      "the hub did not say where to send the file"
    );
  });
});

describe("putPart", () => {
  it("should put the bytes at the part's own address and report their progress when the part is sent", async () => {
    const progress: number[] = [];

    await putPart("u 1", 2, body(16), { onProgress: (loaded) => progress.push(loaded) });

    const request = FakeRequest.made[0];
    expect(request?.method).toBe("PUT");
    expect(request?.url).toBe("/api/ui/uploads/u%201/parts/2");
    expect(request?.payload?.size).toBe(16);
    expect(progress).toEqual([16]);
  });

  it("should give the hub's sentence when it refuses the part", async () => {
    FakeRequest.status = 409;
    FakeRequest.body = JSON.stringify({ error: "part 2 came before part 1" });

    await expect(putPart("u1", 2, body(4))).rejects.toThrow("part 2 came before part 1");
  });

  it("should say the connection was lost when the request itself fails", async () => {
    FakeRequest.failWith = "error";

    await expect(putPart("u1", 0, body(4))).rejects.toThrow("the connection was lost while the file was uploading");
  });

  it("should say it timed out when the request takes too long", async () => {
    FakeRequest.failWith = "timeout";

    await expect(putPart("u1", 0, body(4))).rejects.toThrow("the upload timed out; try again");
  });

  it("should stop the request and report it as stopped when the signal is aborted in flight", async () => {
    FakeRequest.hold = true;
    const controller = new AbortController();
    const sending = putPart("u1", 0, body(4), { signal: controller.signal });

    controller.abort();

    await expect(sending).rejects.toBeInstanceOf(UploadAborted);
  });

  it("should send nothing when the signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(putPart("u1", 0, body(4), { signal: controller.signal })).rejects.toBeInstanceOf(UploadAborted);
    expect(FakeRequest.made).toHaveLength(0);
  });
});

describe("discardUpload", () => {
  it("should delete the upload when the person changes their mind", async () => {
    const call = answers({});

    await discardUpload("u 1");

    expect(call).toHaveBeenCalledWith("/api/ui/uploads/u%201", { method: "DELETE" });
  });

  it("should stay quiet when the discard cannot be delivered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );

    await expect(discardUpload("u1")).resolves.toBeUndefined();
  });
});

describe("uploadFile", () => {
  it("should send the file in order as parts of the size the hub asked for when it is bigger than one part", async () => {
    answers({ uploadId: "u1", partBytes: 4, parts: 3 }, 201);
    const progress: number[] = [];

    const uploadId = await uploadFile({
      conversationId: "c1",
      name: "a.bin",
      mediaType: "application/octet-stream",
      body: body(10),
      onProgress: (sent) => progress.push(sent)
    });

    expect(uploadId).toBe("u1");
    expect(FakeRequest.made.map((request) => request.url)).toEqual(["/api/ui/uploads/u1/parts/0", "/api/ui/uploads/u1/parts/1", "/api/ui/uploads/u1/parts/2"]);
    expect(FakeRequest.made.map((request) => request.payload?.size)).toEqual([4, 4, 2]);
    expect(progress).toEqual([4, 4, 8, 8, 10, 10]);
  });

  it("should say which upload the file belongs to as soon as it is claimed when parts are still going", async () => {
    answers({ uploadId: "u1", partBytes: 4, parts: 1 }, 201);
    const claimed: string[] = [];

    await uploadFile({
      conversationId: "c1",
      name: "a.bin",
      mediaType: "application/octet-stream",
      body: body(4),
      onCreated: (uploadId) => claimed.push(uploadId)
    });

    expect(claimed).toEqual(["u1"]);
  });

  it("should send nothing when the hub does not give a usable part size", async () => {
    answers({ uploadId: "u1", partBytes: 0, parts: 1 }, 201);

    await expect(uploadFile({ conversationId: "c1", name: "a.bin", mediaType: "application/octet-stream", body: body(10) })).rejects.toThrow(
      "the hub did not say where to send the file"
    );
    expect(FakeRequest.made).toHaveLength(0);
  });

  it("should send nothing when the hub expects a different number of parts from the browser's own count", async () => {
    answers({ uploadId: "u1", partBytes: 4, parts: 9 }, 201);

    await expect(uploadFile({ conversationId: "c1", name: "a.bin", mediaType: "application/octet-stream", body: body(10) })).rejects.toThrow(
      "the hub expects this file in a different number of pieces"
    );
    expect(FakeRequest.made).toHaveLength(0);
  });

  it("should stop after the part that failed when the hub refuses one", async () => {
    answers({ uploadId: "u1", partBytes: 4, parts: 3 }, 201);
    FakeRequest.status = 500;

    await expect(uploadFile({ conversationId: "c1", name: "a.bin", mediaType: "application/octet-stream", body: body(10) })).rejects.toThrow(
      "the file could not be attached (500)"
    );
    expect(FakeRequest.made).toHaveLength(1);
  });
});
