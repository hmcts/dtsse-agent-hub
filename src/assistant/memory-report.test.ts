import { describe, expect, it } from "vitest";
import { CONVERSATION_SESSIONS } from "../orchestrator/manifests.ts";
import { SIZE_RESOURCES, VIRTUAL_AGENT_SIZES } from "../virtual-agents/size.ts";
import {
  CONVERSATION_MEMORY_BYTES,
  chatCapacity,
  type MemoryReportRow,
  type MemoryUse,
  memoryAdvice,
  memoryPressure,
  memoryUse,
  memoryWarning,
  nextSizeUp,
  offerMemory,
  POD_BASELINE_MEMORY_BYTES,
  sizeChangeQuestion,
  sizeOffer,
  sizeOffers,
  sizeSentence
} from "./memory-report.ts";

const AT = new Date("2026-10-30T09:00:00.000Z");
const LIMIT = 8 * 1024 ** 3;

/** A `SizeResources` memory figure as bytes, so the checks below compare it against the constants in their own unit. */
const giBytes = (gi: string) => Number(gi.replace("Gi", "")) * 1024 ** 3;

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

/** A size's memory limit in bytes, out of the table the orchestrator applies rather than written out here. */
function limitOf(size: (typeof VIRTUAL_AGENT_SIZES)[number]): number {
  return giBytes(SIZE_RESOURCES[size].limits.memory);
}

/**
 * A report from a pod of `size` holding `chats` conversations and nothing unusual, with both figures that count page
 * cache pinned at the limit so neither of them can be what decides.
 */
function holdingChats(size: (typeof VIRTUAL_AGENT_SIZES)[number], chats: number): MemoryUse {
  const limit = limitOf(size);
  return {
    reported: true,
    limitBytes: limit,
    currentBytes: limit,
    peakBytes: limit,
    anonBytes: POD_BASELINE_MEMORY_BYTES + chats * CONVERSATION_MEMORY_BYTES,
    at: AT.toISOString(),
    stopped: false
  };
}

describe("memoryPressure", () => {
  // In bytes rather than through the constant, because the threshold is a measured cost: a test that reads it back
  // from `CONVERSATION_MEMORY_BYTES` holds either side of the boundary wherever the constant happens to sit.
  it("should put the threshold a measured 0.65Gi under the limit when the pod has reported", () => {
    const measured = Math.round(0.65 * 1024 ** 3);

    expect(memoryPressure(reported(measured), 2, "small")).toBeUndefined();
    expect(memoryPressure(reported(measured - 1), 2, "small")).toMatchObject({ limitBytes: LIMIT });
  });

  /**
   * **The warning must not be reachable by opening chats, at any size, at whatever cap that size currently holds.**
   *
   * This is computed from `CONVERSATION_SESSIONS` and `SIZE_RESOURCES` rather than from figures written out here, so
   * that raising a cap past the point where a pod's own chats would trip the warning fails *this* instead of quietly
   * invalidating a number in a comment. Prose saying "2.90Gi at a cap of 3" has gone stale three times, twice on a
   * line git did not conflict on; an assertion cannot.
   *
   * A pod at its cap holds `POD_BASELINE_MEMORY_BYTES + cap × CONVERSATION_MEMORY_BYTES`, with both cache-bearing
   * figures pinned at the limit so neither of them can be what decides.
   */
  it.each(VIRTUAL_AGENT_SIZES)("should stay quiet for a %s pod holding its whole complement of chats", (size) => {
    const chats = CONVERSATION_SESSIONS[size];

    expect(memoryPressure(holdingChats(size, chats), chats, size)).toBeUndefined();
  });

  /**
   * **Where the two actually meet**, which is what `memoryPressure`'s comment states as a formula.
   *
   * The comment above only pins today's caps, and a wrong formula sat beside it for a round because of that: it had
   * `limit − 2 × CONVERSATION_MEMORY_BYTES` where the algebra gives `limit − POD_BASELINE_MEMORY_BYTES −
   * CONVERSATION_MEMORY_BYTES`, which overstates at every size, and no cap is anywhere near the bound so nothing
   * failed. This computes the bound the same way the comment claims it and checks both sides of it, so the formula is
   * pinned rather than the caps — a cap rise cannot invalidate it, and a wrong formula cannot survive it.
   *
   * **Every size, not one worked example.** Putting that wrong form back fails `small` and `large` and *passes*
   * `medium`, because 22.62 and 22.15 both floor to 22. Simplified down to a single size this would have had a
   * one-in-three chance of missing the exact error it exists to catch.
   */
  it.each(VIRTUAL_AGENT_SIZES)("should start warning a %s pod one chat past the bound in memoryPressure", (size) => {
    const bound = Math.floor((limitOf(size) - POD_BASELINE_MEMORY_BYTES - CONVERSATION_MEMORY_BYTES) / CONVERSATION_MEMORY_BYTES);

    expect(memoryPressure(holdingChats(size, bound), bound, size)).toBeUndefined();
    expect(memoryPressure(holdingChats(size, bound + 1), bound + 1, size)).toBeDefined();
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
      "It is holding 8 GB of its 8 GB in memory that cannot be freed up, which leaves less than another chat's worth spare. Move up to medium below for 8Gi–16Gi of memory and 6 chats at once. Closing a chat frees about 0.65 GB of it."
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
  // The caps and memory as figures rather than read back from the constants: a cap is a measured ceiling on what a
  // pod of that size holds, and reading it back would pass whatever the constant happened to say.
  it("should offer every size's cap and memory, smallest first", () => {
    expect(sizeOffers()).toEqual([
      { size: "small", chats: 4, requests: "4Gi", limit: "8Gi" },
      { size: "medium", chats: 6, requests: "8Gi", limit: "16Gi" },
      { size: "large", chats: 8, requests: "16Gi", limit: "32Gi" }
    ]);
  });

  // The binding constraint on every cap, and the tighter of the two: a pod over its memory **request** is an
  // eviction candidate under node pressure however much its limit leaves spare, where the warning only measures
  // against the limit. So this is the check that fixes `small` at 4 rather than 5, and it derives from the two
  // constants rather than restating them — a figure written in here passes at whatever they are later re-measured
  // to, which is the failure the worked tables elsewhere already had.
  it.each(sizeOffers())("should keep $size's full complement of chats inside the memory it requests", ({ chats, requests }) => {
    expect(POD_BASELINE_MEMORY_BYTES + chats * CONVERSATION_MEMORY_BYTES).toBeLessThanOrEqual(giBytes(requests));
  });

  // The other side of it for `small` alone, which is what makes 4 a ceiling there and not a bound that happens to
  // hold: a fifth chat does not fit inside its 4Gi. Not asserted for the other two, because their requests are not
  // what binds them — `medium` would hold ten and `large` twenty-three, and what stops them short of that is the
  // absence of any measurement above two concurrent sessions.
  it("should have no room inside small's request for a chat beyond its cap", () => {
    const { chats, requests } = sizeOffer("small");

    expect(POD_BASELINE_MEMORY_BYTES + (chats + 1) * CONVERSATION_MEMORY_BYTES).toBeGreaterThan(giBytes(requests));
  });
});

describe("offerMemory", () => {
  // Both figures: the cap comes from the request and the warning measures the peak against the limit, so naming one
  // leaves the other unexplained where it appears in the same panel.
  it.each([
    ["small", "4Gi–8Gi"],
    ["medium", "8Gi–16Gi"],
    ["large", "16Gi–32Gi"]
  ] as const)("should give %s the memory it is guaranteed through to the memory it is killed at", (size, said) => {
    expect(offerMemory(sizeOffer(size))).toBe(said);
  });
});

describe("chatCapacity", () => {
  // The pod's own figure, because a cap is in the pod template: raising the constant reaches a running pod only when
  // it next rolls, and at its cap the pod stops an idle session to make room rather than queueing. A chat offered
  // beyond what the pod has a slot for would end one the person did not close.
  it("should take what the pod reported, and name the cap a restart would give it, when the two disagree", () => {
    expect(chatCapacity(3, "small", true)).toEqual({ now: 3, fromRestart: 4 });
  });

  it("should name no restart when the pod already reports its size's cap", () => {
    expect(chatCapacity(4, "small", true)).toEqual({ now: 4, fromRestart: undefined });
  });

  // **No `now` at all** rather than the cap as a fallback: the hub cannot see a pod's supervisor, so the cap is what
  // the pod will be given and not what it was given, and stating it as current is the same one-too-high figure the
  // reported case exists to avoid.
  it.each([
    ["small", 4],
    ["medium", 6],
    ["large", 8]
  ] as const)("should claim nothing about %s's current chats, and name its cap, when the pod has reported nothing", (size, cap) => {
    expect(chatCapacity(null, size, true)).toEqual({ now: undefined, fromRestart: cap });
  });

  // A stopped pod runs no chats, so a figure in the present tense is false whatever it last reported. Nothing clears
  // `sessions_max`, so that last figure outlives the pod that sent it.
  it("should claim nothing about a stopped pod's current chats, however recently it reported", () => {
    expect(chatCapacity(4, "small", false)).toEqual({ now: undefined, fromRestart: 4 });
  });

  // The trap the stopped case exists for: the dead `small` pod's 4 would otherwise be read back as `medium`'s.
  it("should not attribute a stopped pod's cap to a size it was resized to while stopped", () => {
    expect(chatCapacity(4, "medium", false)).toEqual({ now: undefined, fromRestart: 6 });
  });
});

describe("sizeSentence", () => {
  it("should say the chats and memory when the pod reports its size's cap", () => {
    expect(sizeSentence("small", chatCapacity(4, "small", true))).toBe("You are on small: 4 chats at once, 4Gi–8Gi of memory.");
  });

  it("should say both figures when the pod is behind its size's cap", () => {
    expect(sizeSentence("small", chatCapacity(3, "small", true))).toBe(
      "You are on small: 3 chats at once, 4Gi–8Gi of memory. It holds 4 chats at once from its next restart."
    );
  });

  // The sentence has to be sayable without a current figure, which is the whole reason it lives here.
  it("should name no current figure when the pod has reported nothing", () => {
    expect(sizeSentence("medium", chatCapacity(null, "medium", true))).toBe(
      "You are on medium, with 8Gi–16Gi of memory. It holds 6 chats at once from its next restart."
    );
  });

  // It would otherwise read "You are on small: 4 chats at once" directly above "Your assistant is stopped."
  it("should name no current figure for a stopped pod, whatever it last reported", () => {
    expect(sizeSentence("small", chatCapacity(4, "small", false))).toBe(
      "You are on small, with 4Gi–8Gi of memory. It holds 4 chats at once from its next restart."
    );
  });
});

describe("nextSizeUp", () => {
  it("should step up through the sizes and stop at the largest", () => {
    expect([nextSizeUp("small"), nextSizeUp("medium"), nextSizeUp("large")]).toEqual(["medium", "large", undefined]);
  });
});
