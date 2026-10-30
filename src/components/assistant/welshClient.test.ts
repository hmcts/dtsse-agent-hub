import { afterEach, describe, expect, it, vi } from "vitest";
import type { WelshResponse } from "@/assistant/welsh";
import { runWelshJob, type WelshClient, welshClient, welshDownloadUrl } from "./welshClient.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fake(starts: WelshResponse[], reads: WelshResponse[] = []): WelshClient & { started: number; readIds: string[] } {
  const client = {
    started: 0,
    readIds: [] as string[],
    start: vi.fn(async () => {
      client.started++;
      return starts.shift() as WelshResponse;
    }),
    read: vi.fn(async (id: string) => {
      client.readIds.push(id);
      return reads.shift() as WelshResponse;
    }),
    upload: vi.fn(),
    wait: vi.fn(async () => undefined)
  };
  return client;
}

const DONE: WelshResponse = { status: "done", kind: "scan", result: {}, files: [] };

describe("runWelshJob", () => {
  it("should try again while the assistant starts, then read the job back until it is done", async () => {
    // Arrange
    const client = fake([{ status: "waking" }, { status: "pending", job_id: "j1" }], [{ status: "pending", job_id: "j1" }, DONE]);
    const progress: string[] = [];

    // Act
    const answer = await runWelshJob(client, { kind: "scan", product: "cath", args: {} }, { onProgress: (p) => progress.push(p) });

    // Assert
    expect(answer).toEqual(DONE);
    expect(client.started).toBe(2);
    expect(client.readIds).toEqual(["j1", "j1"]);
    expect(progress).toEqual(["waking", "pending", "pending"]);
  });

  it("should stop following a job once it is aborted", async () => {
    const client = fake([{ status: "pending", job_id: "j1" }], [{ status: "pending", job_id: "j1" }]);
    const controller = new AbortController();
    client.wait = vi.fn(async () => controller.abort());
    const answer = await runWelshJob(client, { kind: "scan", product: "cath", args: {} }, { signal: controller.signal });
    expect(answer).toEqual({ status: "pending", job_id: "j1" });
  });
});

describe("welshClient", () => {
  it("should post a job and read the hub's answer", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "pending", job_id: "j1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await welshClient.start({ kind: "scan", product: "cath", args: {} })).toEqual({ status: "pending", job_id: "j1" });
    expect(fetchMock).toHaveBeenCalledWith("/api/ui/assistant/welsh", expect.objectContaining({ method: "POST" }));
  });

  it("should turn a refusal into a failure in the hub's words, as a sentence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "pick a service first" }), { status: 400 }))
    );
    expect(await welshClient.read("j1")).toEqual({ status: "failed", detail: "Pick a service first." });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 500 }))
    );
    expect(await welshClient.read("j1")).toEqual({ status: "failed", detail: "That did not work. Try again." });
  });

  it("should upload a spreadsheet with its name, and say why when it is refused", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ file_id: "f1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["PK"], "Ymateb ŵ.xlsx");
    expect(await welshClient.upload(file)).toEqual({ file_id: "f1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ui/assistant/welsh/files",
      expect.objectContaining({ headers: expect.objectContaining({ "x-file-name": encodeURIComponent("Ymateb ŵ.xlsx") }) })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "that is not an Excel spreadsheet (.xlsx)" }), { status: 400 }))
    );
    expect(await welshClient.upload(file)).toEqual({ error: "That is not an Excel spreadsheet (.xlsx)." });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 }))
    );
    expect(await welshClient.upload(file)).toEqual({ error: "That spreadsheet could not be uploaded. Try again." });
  });

  it("should wait, and stop waiting when aborted", async () => {
    vi.useFakeTimers();
    const waited = welshClient.wait(1000);
    vi.advanceTimersByTime(1000);
    await expect(waited).resolves.toBeUndefined();
    const controller = new AbortController();
    const cut = welshClient.wait(60_000, controller.signal);
    controller.abort();
    await expect(cut).resolves.toBeUndefined();
  });

  it("should build a download link for a file", () => {
    expect(welshDownloadUrl("f 1")).toBe("/api/ui/assistant/welsh/files/f%201");
  });
});
