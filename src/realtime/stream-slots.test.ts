import { afterEach, describe, expect, it } from "vitest";
import { AGENT_STREAMS_PER_PERSON, createStreamSlots, streamLimits, UI_STREAMS_PER_PERSON } from "./stream-slots.ts";

describe("createStreamSlots", () => {
  it("should refuse a slot when the person already holds the limit", () => {
    const slots = createStreamSlots(2);

    expect(slots.take("alice")).toBeTypeOf("function");
    expect(slots.take("alice")).toBeTypeOf("function");
    expect(slots.take("alice")).toBeUndefined();
    expect(slots.held("alice")).toBe(2);
  });

  it("should count each person separately when several hold streams", () => {
    const slots = createStreamSlots(1);

    expect(slots.take("alice")).toBeDefined();
    expect(slots.take("bob")).toBeDefined();
    expect(slots.take("alice")).toBeUndefined();
  });

  it("should give a slot back when it is released", () => {
    const slots = createStreamSlots(1);
    const release = slots.take("alice");

    release?.();

    expect(slots.held("alice")).toBe(0);
    expect(slots.take("alice")).toBeDefined();
  });

  it("should give a slot back only once when the release runs twice", () => {
    const slots = createStreamSlots(3);
    const first = slots.take("alice");
    slots.take("alice");

    first?.();
    first?.();

    expect(slots.held("alice")).toBe(1);
  });
});

describe("streamLimits", () => {
  const global = globalThis as unknown as { agentHubStreamLimits?: unknown };

  afterEach(() => {
    delete global.agentHubStreamLimits;
  });

  it("should share one set of slots when called from different places", () => {
    expect(streamLimits()).toBe(streamLimits());
    expect(global.agentHubStreamLimits).toBe(streamLimits());
  });

  it("should cap UI and agent streams separately when a person holds both", () => {
    const { ui, agent } = streamLimits();
    for (let taken = 0; taken < UI_STREAMS_PER_PERSON; taken += 1) {
      ui.take("alice");
    }

    expect(ui.take("alice")).toBeUndefined();
    expect(agent.take("alice")).toBeDefined();
    for (let taken = 1; taken < AGENT_STREAMS_PER_PERSON; taken += 1) {
      agent.take("alice");
    }
    expect(agent.take("alice")).toBeUndefined();
  });
});
