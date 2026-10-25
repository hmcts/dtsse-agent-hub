import { describe, expect, it } from "vitest";
import { VIRTUAL_AGENT_STATUSES, type VirtualAgentStatus } from "../virtual-agents/lifecycle.ts";
import { firstWarmupMessage, nextWarmupMessage, pickMessage, WARMUP_ANY, type WarmupPhase, waitingForPerson, warmupPhase, warmupPool } from "./warmup.ts";

describe("warmupPhase", () => {
  it.each([
    ["requested", "starting"],
    ["provisioning", "starting"],
    ["stopping", "starting"],
    ["stopped", "starting"],
    ["awaiting_credentials", "any"],
    ["awaiting_login", "any"],
    ["cloning", "cloning"],
    ["running", "any"],
    ["failed", "any"]
  ] satisfies [VirtualAgentStatus, WarmupPhase][])("should be the %s phase when the assistant is %s", (status, phase) => {
    expect(warmupPhase(status)).toBe(phase);
  });
});

describe("waitingForPerson", () => {
  it("should be true when the assistant has stopped to ask the person for a sign-in", () => {
    expect(waitingForPerson("awaiting_credentials")).toBe(true);
    expect(waitingForPerson("awaiting_login")).toBe(true);
  });

  it("should be false for every other status, so nothing else is sent to the connections", () => {
    const others = VIRTUAL_AGENT_STATUSES.filter((status) => status !== "awaiting_credentials" && status !== "awaiting_login");

    expect(others.map((status) => waitingForPerson(status))).toEqual(others.map(() => false));
  });
});

describe("warmupPool", () => {
  it("should offer the phase's own messages when it has some", () => {
    expect(warmupPool("cloning")).toContain("Working out what SSCS stands for.");
    expect(warmupPool("starting")).toContain("Putting the kettle on.");
  });

  it("should fall back to the messages that fit any phase when the phase has none of its own", () => {
    expect(warmupPool("any")).toBe(WARMUP_ANY);
  });

  it.each(["starting", "cloning", "any"] satisfies WarmupPhase[])("should have something to say in the %s phase", (phase) => {
    expect(warmupPool(phase).length).toBeGreaterThan(0);
  });
});

describe("firstWarmupMessage", () => {
  it("should be the same message every time so the server and the browser agree", () => {
    expect(firstWarmupMessage("starting")).toBe("Warming up. Go and grab a cuppa.");
    expect(firstWarmupMessage("starting")).toBe(firstWarmupMessage("starting"));
  });
});

describe("pickMessage", () => {
  const pool = ["one", "two", "three"];

  it("should choose by the random value across the pool when nothing is showing", () => {
    expect(pickMessage(pool, "", 0)).toBe("one");
    expect(pickMessage(pool, "", 0.5)).toBe("two");
    expect(pickMessage(pool, "", 0.99)).toBe("three");
  });

  it("should leave out the message showing so it never repeats", () => {
    expect(pickMessage(pool, "one", 0)).toBe("two");
    expect(pickMessage(pool, "two", 0.99)).toBe("three");
    expect(pickMessage(pool, "three", 0)).toBe("one");
  });

  it("should stay inside the pool when the random value rounds up to its length", () => {
    expect(pickMessage(pool, "", 1)).toBe("three");
    expect(pickMessage(pool, "one", 1)).toBe("three");
  });

  it("should alternate rather than deadlock when the pool has two messages", () => {
    const two = ["left", "right"];

    expect(pickMessage(two, "left", 0)).toBe("right");
    expect(pickMessage(two, "left", 0.99)).toBe("right");
    expect(pickMessage(two, "right", 0)).toBe("left");
  });

  it("should repeat the only message rather than fail when the pool has one", () => {
    expect(pickMessage(["alone"], "alone", 0.4)).toBe("alone");
  });
});

describe("nextWarmupMessage", () => {
  it("should pick from the phase's pool and never repeat the message showing", () => {
    const first = firstWarmupMessage("cloning");
    const next = nextWarmupMessage("cloning", first, 0);

    expect(warmupPool("cloning")).toContain(next);
    expect(next).not.toBe(first);
  });

  it("should fall back to the lines that fit any phase when the assistant is doing something with none", () => {
    expect(WARMUP_ANY).toContain(nextWarmupMessage("any", firstWarmupMessage("any"), 0.9));
  });
});
