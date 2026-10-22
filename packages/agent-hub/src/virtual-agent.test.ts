import { afterEach, describe, expect, it } from "vitest";
import { MISSING_LAUNCH_TOKEN, MISSING_VIRTUAL_AGENT_ID, requireVirtualAgent, virtualAgent } from "./virtual-agent.ts";

const ID = "0f8a6a1e-1234-4000-8000-000000000001";
const TOKEN = "lt-abc123";

afterEach(() => {
  delete process.env.AGENT_HUB_VIRTUAL_AGENT_ID;
  delete process.env.AGENT_HUB_LAUNCH_TOKEN;
});

describe("virtualAgent", () => {
  it("should give the id and launch token when both are set", () => {
    expect(virtualAgent({ AGENT_HUB_VIRTUAL_AGENT_ID: ID, AGENT_HUB_LAUNCH_TOKEN: TOKEN })).toEqual({ id: ID, launchToken: TOKEN });
  });

  it("should be null when neither is set", () => {
    expect(virtualAgent({})).toBeNull();
  });

  it("should be null when only the id is set", () => {
    expect(virtualAgent({ AGENT_HUB_VIRTUAL_AGENT_ID: ID })).toBeNull();
  });

  it("should be null when only the launch token is set", () => {
    expect(virtualAgent({ AGENT_HUB_LAUNCH_TOKEN: TOKEN })).toBeNull();
  });

  it("should be null when either is set but empty", () => {
    expect(virtualAgent({ AGENT_HUB_VIRTUAL_AGENT_ID: "", AGENT_HUB_LAUNCH_TOKEN: TOKEN })).toBeNull();
    expect(virtualAgent({ AGENT_HUB_VIRTUAL_AGENT_ID: ID, AGENT_HUB_LAUNCH_TOKEN: "" })).toBeNull();
  });

  it("should read the process environment when none is passed", () => {
    expect(virtualAgent()).toBeNull();
    process.env.AGENT_HUB_VIRTUAL_AGENT_ID = ID;
    process.env.AGENT_HUB_LAUNCH_TOKEN = TOKEN;
    expect(virtualAgent()).toEqual({ id: ID, launchToken: TOKEN });
  });
});

describe("requireVirtualAgent", () => {
  it("should give the agent when the pod environment is complete", () => {
    expect(requireVirtualAgent({ AGENT_HUB_VIRTUAL_AGENT_ID: ID, AGENT_HUB_LAUNCH_TOKEN: TOKEN })).toEqual({ id: ID, launchToken: TOKEN });
  });

  it("should say this only runs in a pod when the id is missing", () => {
    expect(() => requireVirtualAgent({})).toThrow(MISSING_VIRTUAL_AGENT_ID);
    expect(() => requireVirtualAgent({ AGENT_HUB_LAUNCH_TOKEN: TOKEN })).toThrow(MISSING_VIRTUAL_AGENT_ID);
  });

  it("should name the launch token when the id is set but the token is not", () => {
    expect(() => requireVirtualAgent({ AGENT_HUB_VIRTUAL_AGENT_ID: ID })).toThrow(MISSING_LAUNCH_TOKEN);
  });

  it("should read the process environment when none is passed", () => {
    expect(() => requireVirtualAgent()).toThrow(MISSING_VIRTUAL_AGENT_ID);
  });
});
