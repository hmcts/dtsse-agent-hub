import { afterEach, describe, expect, it, vi } from "vitest";
import { type PodJobEvents, PodJobRefused, requestPodJob, waitForPodJob } from "./podJobClient.ts";

afterEach(() => {
  vi.useRealTimers();
});

const PENDING = { job_id: "j1", kind: "test.echo", status: "pending" };
const DONE = { job_id: "j1", kind: "test.echo", status: "done", result: { echoed: "hi" } };

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch answering each call with the next of `answers`, the last one over and over. */
function fakeFetch(...answers: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    return await (next as () => Response | Promise<Response>)();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** The hub stream's pod-job frames, sent by hand. */
function fakeEvents(): { events: PodJobEvents; emit: (data: unknown) => void; listeners: () => number } {
  const listeners = new Set<(data: unknown) => void>();
  return {
    events: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (data) => {
      for (const listener of [...listeners]) {
        listener(data);
      }
    },
    listeners: () => listeners.size
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("requestPodJob", () => {
  it("should post the kind and args to the conversation's route and answer what the hub says", async () => {
    // Arrange
    const { fetchImpl, calls } = fakeFetch(() => reply(200, { status: "pending", job_id: "j1" }));

    // Act
    const asked = await requestPodJob("c/1", "test.echo", { text: "hi" }, { fetchImpl });

    // Assert
    expect(asked).toEqual({ status: "pending", job_id: "j1" });
    expect(calls[0]?.url).toBe("/api/ui/assistant/pod-jobs/c%2F1");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ kind: "test.echo", args: { text: "hi" } });
  });

  it("should throw a refusal with the hub's status and words", async () => {
    // Arrange
    const { fetchImpl } = fakeFetch(() => reply(429, { error: "that is a lot at once" }));

    // Act
    const refused = await requestPodJob("c1", "test.echo", {}, { fetchImpl, signal: new AbortController().signal }).catch((e: unknown) => e);

    // Assert
    expect(refused).toBeInstanceOf(PodJobRefused);
    expect(refused).toMatchObject({ status: 429, message: "that is a lot at once" });
  });

  it("should throw a refusal in its own words when the hub gave none", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("oops", { status: 500 }));

    await expect(requestPodJob("c1", "test.echo", {}, { fetchImpl })).rejects.toMatchObject({ status: 500, message: "That did not work. Try again." });
  });
});

describe("waitForPodJob", () => {
  it("should read the job again as soon as its frame arrives, and stop listening once it is done", async () => {
    // Arrange
    const { fetchImpl, calls } = fakeFetch(
      () => reply(200, PENDING),
      () => reply(200, DONE)
    );
    const hub = fakeEvents();
    const waiting = waitForPodJob("c1", "j1", { fetchImpl, events: hub.events, pollMs: 60_000 });
    await settle();

    // Act
    hub.emit({ job_id: "another", conversation_id: "c1" });
    hub.emit({ job_id: "j1", conversation_id: "c1" });

    // Assert
    expect(await waiting).toEqual(DONE);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("/api/ui/assistant/pod-jobs/c1/j1");
    expect(hub.listeners()).toBe(0);
  });

  it("should poll every couple of seconds when no frame arrives, and through a network fault", async () => {
    // Arrange
    vi.useFakeTimers();
    const { fetchImpl, calls } = fakeFetch(
      () => reply(200, PENDING),
      () => Promise.reject(new TypeError("offline")),
      () => reply(200, { ...PENDING, status: "timeout" })
    );

    // Act
    const waiting = waitForPodJob("c1", "j1", { fetchImpl });
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    // Assert
    expect(await waiting).toEqual({ ...PENDING, status: "timeout" });
    expect(calls).toHaveLength(3);
  });

  it.each([500, 502, 503, 429])("should keep waiting through a %s and read the job on the next poll", async (status) => {
    // Arrange
    vi.useFakeTimers();
    const { fetchImpl, calls } = fakeFetch(
      () => reply(status, { error: "try later" }),
      () => reply(200, DONE)
    );

    // Act
    const waiting = waitForPodJob("c1", "j1", { fetchImpl });
    await vi.advanceTimersByTimeAsync(2000);

    // Assert
    expect(await waiting).toEqual(DONE);
    expect(calls).toHaveLength(2);
  });

  it("should read once more when a frame arrives during a read, rather than lose it", async () => {
    // Arrange
    let release: (response: Response) => void = () => undefined;
    const { fetchImpl, calls } = fakeFetch(
      () => new Promise<Response>((resolve) => (release = resolve)),
      () => reply(200, DONE)
    );
    const hub = fakeEvents();
    const waiting = waitForPodJob("c1", "j1", { fetchImpl, events: hub.events, pollMs: 60_000 });
    await settle();

    // Act
    hub.emit({ job_id: "j1" });
    release(reply(200, PENDING));

    // Assert
    expect(await waiting).toEqual(DONE);
    expect(calls).toHaveLength(2);
  });

  it("should answer missing for a job the hub no longer holds", async () => {
    const { fetchImpl } = fakeFetch(() => reply(404, { error: "that job is not there" }));

    expect(await waitForPodJob("c1", "j1", { fetchImpl })).toEqual({ job_id: "j1", status: "missing" });
  });

  it.each([400, 401, 403])("should reject with a %s, which is a refusal", async (status) => {
    const { fetchImpl } = fakeFetch(() => reply(status, { error: "sign in first" }));

    await expect(waitForPodJob("c1", "j1", { fetchImpl })).rejects.toMatchObject({ status, message: "sign in first" });
  });

  it("should reject with the signal's reason when the wait is aborted, and stop listening", async () => {
    // Arrange
    const { fetchImpl } = fakeFetch(() => reply(200, PENDING));
    const hub = fakeEvents();
    const controller = new AbortController();
    const waiting = waitForPodJob("c1", "j1", { fetchImpl, events: hub.events, signal: controller.signal, pollMs: 60_000 });
    await settle();

    // Act
    controller.abort(new Error("closed the panel"));

    // Assert
    await expect(waiting).rejects.toThrow("closed the panel");
    expect(hub.listeners()).toBe(0);
  });

  it("should reject at once when the signal has already been aborted", async () => {
    const { fetchImpl, calls } = fakeFetch(() => reply(200, PENDING));
    const controller = new AbortController();
    controller.abort();

    await expect(waitForPodJob("c1", "j1", { fetchImpl, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });

  it("should reject with an AbortError when the signal aborts with no reason of its own", async () => {
    const { fetchImpl } = fakeFetch(() => reply(200, PENDING));
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener: (_: string, fire: () => void) => setTimeout(fire, 0),
      removeEventListener: () => undefined
    };

    await expect(waitForPodJob("c1", "j1", { fetchImpl, signal: signal as unknown as AbortSignal, pollMs: 60_000 })).rejects.toMatchObject({
      name: "AbortError"
    });
  });
});
