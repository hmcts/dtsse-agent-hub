import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipJson, putBlob, RETRY_DELAYS_MS, ReviewRequestFailed, reviewApi, UploadFailed, withRetries } from "./reviewClient.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reviewApi", () => {
  it("should word a refusal in the route's own words", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "that is a lot at once" }, { status: 429 }))
    );
    const failure = await reviewApi("tok")
      .people()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReviewRequestFailed);
    expect(failure).toMatchObject({ status: 429, message: "That is a lot at once" });
  });

  it("should say the hub could not be reached when fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      })
    );
    await expect(reviewApi("tok").threads("/")).rejects.toMatchObject({ status: 0 });
  });

  it("should fall back to a general message for an answer with no error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 500 }))
    );
    await expect(reviewApi("tok").startRecording()).rejects.toMatchObject({ status: 500, message: "Something went wrong. Try again." });
  });

  it("should send a thread made during a recording with its offset", async () => {
    const fetched = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ thread: { id: "t" }, snapshot_url: null }, { status: 201 }));
    vi.stubGlobal("fetch", fetched);
    const anchor = { selector: "#a", text: "", tag: "a", rect: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 1, height: 1 } };
    const created = await reviewApi("tok").createThread({ pagePath: "/", anchor, body: "Hi", snapshot: false, recording: { id: "r", offsetMs: 42 } });
    expect(created.snapshotUrl).toBeNull();
    expect(JSON.parse(fetched.mock.calls[0]?.[1]?.body as string)).toMatchObject({ recording_id: "r", offset_ms: 42 });
  });
});

describe("gzipJson", () => {
  it("should gzip the JSON of a value", async () => {
    const bytes = await gzipJson([{ a: 1 }]);
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
    const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    expect(JSON.parse(text)).toEqual([{ a: 1 }]);
  });
});

describe("putBlob", () => {
  it("should put a block blob and refuse an answer that is not ok", async () => {
    const fetched = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetched);
    await expect(putBlob("https://blob.example/x", new Uint8Array([1]), "application/json")).rejects.toBeInstanceOf(UploadFailed);
    expect(fetched.mock.calls[0]?.[1]).toMatchObject({ method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "content-type": "application/json" } });
  });
});

describe("withRetries", () => {
  const wait = vi.fn(async () => undefined);

  it("should try again after each delay, then give up", async () => {
    const work = vi.fn(async () => {
      throw new UploadFailed(500);
    });
    await expect(withRetries(work, wait)).rejects.toBeInstanceOf(UploadFailed);
    expect(work).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
  });

  it("should answer as soon as one try works", async () => {
    let tries = 0;
    expect(
      await withRetries(async () => {
        tries += 1;
        if (tries === 1) {
          throw new ReviewRequestFailed(503, "busy");
        }
        return "done";
      }, wait)
    ).toBe("done");
  });

  it("should not try again when the hub refused the request", async () => {
    const work = vi.fn(async () => {
      throw new ReviewRequestFailed(409, "that recording has stopped");
    });
    await expect(withRetries(work, wait)).rejects.toThrow("that recording has stopped");
    expect(work).toHaveBeenCalledTimes(1);
  });
});
