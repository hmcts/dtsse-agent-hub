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
    memoryAnonBytes: BigInt(2 * 1024 ** 3),
    memoryReportedAt: AT,
    running: true,
    reports: true,
    ...overrides
  };
}

/**
 * A report whose non-reclaimable figure leaves `headroom` bytes under the limit, which is what the threshold is
 * about.
 *
 * Both of the figures that count page cache are pinned at the limit throughout, so every expectation below that the
 * warning stays quiet is also a check that neither decides: a pod that has merely read its workspace clone sits at
 * its ceiling on both of them and must not be warned about for it.
 */
function reported(headroom: number, limit = LIMIT): MemoryUse {
  return { reported: true, limitBytes: limit, currentBytes: limit, peakBytes: limit, anonBytes: limit - headroom, at: AT.toISOString(), stopped: false };
}

describe("memoryUse", () => {
  it("should give the four figures, dated, when the pod has reported", () => {
    expect(memoryUse(row())).toEqual({
      reported: true,
      limitBytes: LIMIT,
      currentBytes: 3 * 1024 ** 3,
      peakBytes: 5 * 1024 ** 3,
      anonBytes: 2 * 1024 ** 3,
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
    "memoryAnonBytes",
    "memoryReportedAt"
  ] as const)("should report nothing when %s alone is missing", (missing) => {
    expect(memoryUse(row({ [missing]: null }))).toEqual({ reported: false, reason: "waiting" });
  });

  // What every row written before `memory_anon_bytes` existed looks like: three figures and a date, and no `anon`.
  // The warning cannot be computed from it, so it is not a report — and the pod that wrote it is on a client that
  // does not claim `memory-anon`, which is what makes "an older version" the right thing to say rather than a guess.
  it("should treat a row from before the anon figure as no report at all, naming the client", () => {
    const beforeAnon = row({ memoryAnonBytes: null, reports: false });

    expect(memoryUse(beforeAnon)).toEqual({ reported: false, reason: "older_client" });
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

  // Page cache is reclaimed at the limit rather than given back, so a pod that has read its 6.8GiB workspace clone
  // sits at its ceiling on both `current` and `peak` while holding almost nothing it cannot give up. Warning on
  // either would fire for reading files, when there is in fact room for another chat.
  it("should say nothing when current and peak are at the limit but little of it cannot be reclaimed", () => {
    const cached: MemoryUse = {
      reported: true,
      limitBytes: LIMIT,
      currentBytes: LIMIT,
      peakBytes: LIMIT,
      anonBytes: 1024,
      at: AT.toISOString(),
      stopped: false
    };

    expect(memoryPressure(cached, 2, "small")).toBeUndefined();
  });

  // The figures are the last thing anyone measured, so the section still shows them, but they describe a container
  // that no longer exists: a pod stopped mid-build must not tell its owner the next day that it is low on memory.
  it("should say nothing when the pod that reported it has stopped", () => {
    expect(memoryPressure({ ...reported(0), stopped: true } as MemoryUse, 3, "small")).toBeUndefined();
  });

  // The boundary: exactly one conversation's worth of headroom still has room for the chat the person is about to
  // open, so it is not warned about. One byte less and it has not.
  it("should say nothing when what it cannot reclaim leaves room for exactly one more chat", () => {
    expect(memoryPressure(reported(CONVERSATION_MEMORY_BYTES), 2, "small")).toBeUndefined();
  });

  it("should warn when what it cannot reclaim leaves a byte less than one more chat", () => {
    expect(memoryPressure(reported(CONVERSATION_MEMORY_BYTES - 1), 2, "small")).toMatchObject({ openChats: 2, limitBytes: LIMIT });
  });

  it("should warn when none of what it holds can be reclaimed", () => {
    expect(memoryPressure(reported(0), 3, "small")).toMatchObject({ anonBytes: LIMIT, openChats: 3 });
  });

  // A pod using memory normally within its size must not nag: the warning is about running out of room, not about
  // using what the size is for.
  it("should say nothing when what it cannot reclaim leaves room for several more chats", () => {
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
  it("should say what cannot be freed up and offer a bigger size when there is one and a chat is open", () => {
    const pressure = memoryPressure(reported(0), 3, "small");

    expect(memoryAdvice(pressure!)).toBe(
      `It is holding 8 GB of its 8 GB in memory that cannot be freed up, which leaves less than another chat's worth spare. Move up to medium below for ${SIZE_RESOURCES.medium.limits.memory} of memory and ${CONVERSATION_SESSIONS.medium} chats at once. Closing a chat frees about 0.65 GB of it.`
    );
  });

  // A pod's whole complement of chats cannot reach this threshold at any size, so when it fires the chats are a
  // quarter of what is held and closing one would not change the answer. The size is the remedy; the per-chat figure
  // is a quantity someone deciding what to do should have, not the thing to do.
  it("should not offer closing a chat as the remedy when memory is tight", () => {
    const advice = memoryAdvice(memoryPressure(reported(0), 3, "small")!);

    expect(advice).toContain("Move up to medium below");
    expect(advice).toContain("Closing a chat frees about 0.65 GB of it.");
    expect(advice).not.toContain("close a chat you have finished with");
  });

  // The section's first line says what the pod reached at its busiest, a bigger number than this one. Two sentences
  // using "reached" for two different figures, the second smaller, reads as one of them being wrong.
  it("should name what it is counting rather than say the pod reached it when memory is tight", () => {
    const advice = memoryAdvice(memoryPressure(reported(0), 3, "small")!);

    expect(advice).toContain("It is holding");
    expect(advice).not.toContain("It has reached");
  });

  it("should offer no bigger size on the largest there is when a chat is open", () => {
    const advice = memoryAdvice(memoryPressure(reported(0), 3, "large")!);

    expect(advice).toContain("This is the largest size there is. Closing a chat frees about 0.65 GB of it.");
    expect(advice).not.toContain("Move up to");
  });

  // With nothing open, what closing a chat would free is a fact about nothing.
  it("should leave the per-chat figure out when no chat is open", () => {
    const advice = memoryAdvice(memoryPressure(reported(0), 0, "large")!);

    expect(advice).toBe(
      "It is holding 8 GB of its 8 GB in memory that cannot be freed up, which leaves less than another chat's worth spare. This is the largest size there is."
    );
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
