import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordedEvent } from "../protocol.ts";
import { BATCH_MS, BLOCK_SELECTOR, createRecorder, type RecordFunction, type RecordOptions } from "./recorder.ts";

/** A stand-in for rrweb's `record`: emits a Meta and a FullSnapshot as it starts, as rrweb does on a loaded page. */
function fakeRecord() {
  let emit: ((event: RecordedEvent) => void) | undefined;
  const calls: RecordOptions[] = [];
  const stop = vi.fn(() => {
    emit = undefined;
  });
  const snapshot = (at: number) => {
    emit?.({ type: 4, timestamp: at, data: { href: "x" } });
    emit?.({ type: 2, timestamp: at, data: { node: {} } });
  };
  const record = ((options: RecordOptions) => {
    calls.push(options);
    emit = options.emit;
    snapshot(1);
    return stop;
  }) as unknown as RecordFunction;
  record.takeFullSnapshot = () => snapshot(2);
  return { record, calls, stop, event: (type: number, timestamp: number) => emit?.({ type, timestamp, data: {} }) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createRecorder", () => {
  it("should record with passwords and marked elements always masked", () => {
    const fake = fakeRecord();
    createRecorder(fake.record, vi.fn()).start(true);
    expect(fake.calls[0]).toMatchObject({ maskAllInputs: true, maskInputOptions: { password: true }, blockSelector: BLOCK_SELECTOR });
  });

  it("should post what it records in batches", () => {
    const fake = fakeRecord();
    const post = vi.fn();
    const recorder = createRecorder(fake.record, post);
    recorder.start(false);
    expect(recorder.recording()).toBe(true);
    fake.event(3, 5);
    vi.advanceTimersByTime(BATCH_MS);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0].map((event: RecordedEvent) => event.type)).toEqual([4, 2, 3]);
    vi.advanceTimersByTime(BATCH_MS);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("should post what is left and stop rrweb when stopped", () => {
    const fake = fakeRecord();
    const post = vi.fn();
    const recorder = createRecorder(fake.record, post);
    recorder.start(false);
    recorder.stop();
    expect(fake.stop).toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    expect(recorder.recording()).toBe(false);
  });

  it("should not start twice", () => {
    const fake = fakeRecord();
    const recorder = createRecorder(fake.record, vi.fn());
    recorder.start(false);
    recorder.start(false);
    expect(fake.calls).toHaveLength(1);
  });

  it("should take a snapshot outside a recording without posting it", () => {
    const fake = fakeRecord();
    const post = vi.fn();
    const recorder = createRecorder(fake.record, post);
    expect(recorder.snapshot(true).map((event) => event.type)).toEqual([4, 2]);
    expect(fake.calls[0]?.maskAllInputs).toBe(true);
    expect(fake.stop).toHaveBeenCalled();
    recorder.flush();
    expect(post).not.toHaveBeenCalled();
  });

  it("should take a snapshot during a recording from the running recorder, which keeps it too", () => {
    const fake = fakeRecord();
    const post = vi.fn();
    const recorder = createRecorder(fake.record, post);
    recorder.start(false);
    const snapshot = recorder.snapshot(false);
    expect(snapshot.map((event) => [event.type, event.timestamp])).toEqual([
      [4, 2],
      [2, 2]
    ]);
    expect(fake.calls).toHaveLength(1);
    recorder.flush();
    expect(post.mock.calls[0]?.[0]).toHaveLength(4);
  });
});
