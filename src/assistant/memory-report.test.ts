import { describe, expect, it } from "vitest";
import { CONVERSATION_SESSIONS } from "../orchestrator/manifests.ts";
import { SIZE_RESOURCES } from "../virtual-agents/size.ts";
import {
  CONVERSATION_MEMORY_BYTES,
  type MemoryReportRow,
  type MemoryUse,
  memoryAdvice,
  memoryPressure,
  memoryUse,
  memoryWarning,
  nextSizeUp,
  sizeChangeQuestion,
  sizeOffer,
  sizeOffers
} from "./memory-report.ts";

const AT = new Date("2026-10-30T09:00:00.000Z");
const LIMIT = 8 * 1024 ** 3;

function row(overrides: Partial<MemoryReportRow> = {}): MemoryReportRow {
  return {
    memoryLimitBytes: BigInt(LIMIT),
    memoryCurrentBytes: BigInt(3 * 1024 ** 3),
    memoryPeakBytes: BigInt(5 * 1024 ** 3),
    memoryReportedAt: AT,
    running: true,
    reports: true,
    ...overrides
  };
}

/**
 * A report whose live figure leaves `headroom` bytes under the limit, which is what the threshold is about.
 *
 * Its peak is pinned at the limit throughout, so every expectation below that the warning stays quiet is also a
 * check that the peak is not what decides — a pod whose peak touched the ceiling once is not warned about for ever.
 */
function reported(headroom: number, limit = LIMIT): MemoryUse {
  return { reported: true, limitBytes: limit, currentBytes: limit - headroom, peakBytes: limit, at: AT.toISOString(), stopped: false };
}

describe("memoryUse", () => {
  it("should give the three figures, dated, when the pod has reported", () => {
    expect(memoryUse(row())).toEqual({
      reported: true,
      limitBytes: LIMIT,
      currentBytes: 3 * 1024 ** 3,
      peakBytes: 5 * 1024 ** 3,
      at: "2026-10-30T09:00:00.000Z",
      stopped: false
    });
  });

  // The last thing anyone measured is still worth showing; what it must not do is read as current.
  it("should keep showing the last report, saying the pod is stopped, when it is no longer running", () => {
    expect(memoryUse(row({ running: false }))).toMatchObject({ reported: true, stopped: true });
  });

  it("should say nothing has looked, rather than show a figure, when the pod is not running", () => {
    expect(memoryUse(row({ memoryReportedAt: null, memoryLimitBytes: null, memoryCurrentBytes: null, memoryPeakBytes: null, running: false }))).toEqual({
      reported: false,
      reason: "not_running"
    });
  });

  it("should say the client is too old when the running pod's own session never claimed the feature", () => {
    expect(memoryUse(row({ memoryReportedAt: null, memoryLimitBytes: null, memoryCurrentBytes: null, memoryPeakBytes: null, reports: false }))).toEqual({
      reported: false,
      reason: "older_client"
    });
  });

  it("should say it has not reported yet when the pod is running and claims the feature", () => {
    expect(memoryUse(row({ memoryReportedAt: null, memoryLimitBytes: null, memoryCurrentBytes: null, memoryPeakBytes: null }))).toEqual({
      reported: false,
      reason: "waiting"
    });
  });

  // A row carrying a date and not the figures, or the other way round, is not a report. Half of one would be shown as
  // a measurement, which is the one thing none of this may do.
  it.each([
    "memoryLimitBytes",
    "memoryCurrentBytes",
    "memoryPeakBytes",
    "memoryReportedAt"
  ] as const)("should report nothing when %s alone is missing", (missing) => {
    expect(memoryUse(row({ [missing]: null }))).toEqual({ reported: false, reason: "waiting" });
  });
});

describe("memoryPressure", () => {
  // In bytes rather than through the constant, because the threshold is a measured cost: a test that reads it back
  // from `CONVERSATION_MEMORY_BYTES` holds either side of the boundary wherever the constant happens to sit.
  it("should put the threshold a measured 0.65Gi under the limit when the pod has reported", () => {
    const measured = Math.round(0.65 * 1024 ** 3);

    expect(memoryPressure(reported(measured), 2, "small")).toBeUndefined();
    expect(memoryPressure(reported(measured - 1), 2, "small")).toMatchObject({ limitBytes: LIMIT });
  });

  // `memory.peak` never falls while the pod lives, so a warning computed from it could not be cleared by closing a
  // chat — the one thing the advice asks for. The live figure is what comes back down, so it is what decides.
  it("should say nothing when the peak is at the limit but the live figure has room", () => {
    const peaked: MemoryUse = { reported: true, limitBytes: LIMIT, currentBytes: 1024, peakBytes: LIMIT, at: AT.toISOString(), stopped: false };

    expect(memoryPressure(peaked, 2, "small")).toBeUndefined();
  });

  // The boundary: exactly one conversation's worth of headroom still has room for the chat the person is about to
  // open, so it is not warned about. One byte less and it has not.
  it("should say nothing when the live figure leaves room for exactly one more chat", () => {
    expect(memoryPressure(reported(CONVERSATION_MEMORY_BYTES), 2, "small")).toBeUndefined();
  });

  it("should warn when the live figure leaves a byte less than one more chat", () => {
    expect(memoryPressure(reported(CONVERSATION_MEMORY_BYTES - 1), 2, "small")).toMatchObject({ openChats: 2, limitBytes: LIMIT });
  });

  it("should warn when the live figure is at the limit", () => {
    expect(memoryPressure(reported(0), 3, "small")).toMatchObject({ currentBytes: LIMIT, openChats: 3 });
  });

  // A pod using memory normally within its size must not nag: the warning is about running out of room, not about
  // using what the size is for.
  it("should say nothing when the live figure leaves room for several more chats", () => {
    expect(memoryPressure(reported(4 * CONVERSATION_MEMORY_BYTES), 1, "small")).toBeUndefined();
  });

  it("should offer the next size up when there is one", () => {
    expect(memoryPressure(reported(0), 1, "small")?.nextSize).toEqual(sizeOffer("medium"));
  });

  it("should offer no bigger size on the largest there is", () => {
    expect(memoryPressure(reported(0), 1, "large")?.nextSize).toBeUndefined();
  });

  it.each(["older_client", "not_running", "waiting"] as const)("should say nothing when the pod reported nothing (%s)", (reason) => {
    expect(memoryPressure({ reported: false, reason }, 3, "small")).toBeUndefined();
  });
});

describe("memoryWarning", () => {
  it("should carry one sentence for the cog when memory is tight", () => {
    expect(memoryWarning(memoryPressure(reported(0), 2, "small"))).toBe("Your assistant is low on memory");
  });

  it("should carry nothing when it is not", () => {
    expect(memoryWarning(undefined)).toBeNull();
  });
});

describe("memoryAdvice", () => {
  it("should say where the pod got to and offer both answers when a chat could be closed and a bigger size exists", () => {
    const pressure = memoryPressure(reported(0), 3, "small");

    expect(memoryAdvice(pressure!)).toBe(
      `It has reached 8 GB of its 8 GB, which leaves less than another chat's worth free. Move up to medium below for ${CONVERSATION_SESSIONS.medium} chats at once and ${SIZE_RESOURCES.medium.limits.memory} of memory, or close a chat you have finished with to free about 0.65 GB.`
    );
  });

  // This threshold is not reachable by opening chats at any size, so the cause is page cache or the pod's own work.
  // Saying the chats filled it would be a diagnosis the figures contradict; what closing one frees is a fact.
  it("should not blame the person's chats when it says memory is tight", () => {
    const advice = memoryAdvice(memoryPressure(reported(0), 3, "small")!);

    expect(advice).not.toContain("no room for another chat");
    expect(advice).toContain("to free about 0.65 GB");
  });

  // Telling someone with one chat open to close a chat is telling them to stop working.
  it("should offer only the bigger size when a single chat is open", () => {
    expect(memoryAdvice(memoryPressure(reported(0), 1, "small")!)).not.toContain("or close a chat");
  });

  it("should offer only closing a chat on the largest size there is", () => {
    const advice = memoryAdvice(memoryPressure(reported(0), 3, "large")!);

    expect(advice).toContain("This is the largest size there is, so close a chat you have finished with to free about 0.65 GB.");
    expect(advice).not.toContain("Move up to");
  });
});

describe("sizeChangeQuestion", () => {
  it.each([
    [0, "whatever it is working on"],
    [1, "the one chat you have open"],
    [3, "all 3 chats you have open"]
  ])("should count the chats a change ends when %i are open", (openChats, said) => {
    expect(sizeChangeQuestion("medium", true, openChats)).toBe(`Change to medium? Your assistant restarts, which stops ${said}.`);
  });

  // A pod the orchestrator has not made yet is not restarted by this, and saying it is would be a cost that is not
  // being paid.
  it("should promise the new size at the next start when no pod is up", () => {
    expect(sizeChangeQuestion("large", false, 3)).toBe("Change to large? Your assistant starts at the new size the next time you use it.");
  });
});

describe("sizeOffers", () => {
  it("should describe every size from the constants the orchestrator applies, smallest first", () => {
    expect(sizeOffers()).toEqual([
      { size: "small", chats: CONVERSATION_SESSIONS.small, requests: SIZE_RESOURCES.small.requests.memory, limit: SIZE_RESOURCES.small.limits.memory },
      { size: "medium", chats: CONVERSATION_SESSIONS.medium, requests: SIZE_RESOURCES.medium.requests.memory, limit: SIZE_RESOURCES.medium.limits.memory },
      { size: "large", chats: CONVERSATION_SESSIONS.large, requests: SIZE_RESOURCES.large.requests.memory, limit: SIZE_RESOURCES.large.limits.memory }
    ]);
  });
});

describe("nextSizeUp", () => {
  it("should step up through the sizes and stop at the largest", () => {
    expect([nextSizeUp("small"), nextSizeUp("medium"), nextSizeUp("large")]).toEqual(["medium", "large", undefined]);
  });
});
