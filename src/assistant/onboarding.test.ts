import { describe, expect, it } from "vitest";
import { neededCredentials } from "../virtual-agents/views.ts";
import { connectionsAsk, onboarded, readiness } from "./onboarding.ts";

describe("readiness", () => {
  it("should be complete and ready when the assistant is running", () => {
    expect(readiness("running")).toEqual({ percent: 100, step: "Your assistant is ready", ready: true, failed: false });
  });

  it("should move forward through the pod's start-up when it is starting", () => {
    const percents = (["requested", "provisioning", "awaiting_credentials", "cloning", "running"] as const).map((status) => readiness(status).percent);

    expect(percents).toEqual([...percents].sort((left, right) => left - right));
  });

  it("should say the person has accounts to connect when the pod is waiting for a sign-in", () => {
    expect(readiness("awaiting_login").step).toBe("Waiting for you to connect your accounts…");
  });

  it("should say it failed when the assistant has failed", () => {
    expect(readiness("failed")).toMatchObject({ percent: 0, ready: false, failed: true });
  });
});

describe("onboarded", () => {
  it.each([
    ["own-licence", ["github", "claude"]],
    ["bedrock", ["github", "bedrock"]]
  ] as const)("should be onboarded without Azure when the %s route's needed credentials are stored", (route, stored) => {
    expect(onboarded(neededCredentials(route), new Set(stored))).toBe(true);
  });

  it("should be onboarded when every needed credential is stored", () => {
    expect(onboarded(["github", "azure", "claude"], new Set(["github", "azure", "claude", "jenkins"]))).toBe(true);
  });

  it("should not be onboarded when a needed credential is missing", () => {
    expect(onboarded(["github", "azure", "bedrock"], new Set(["github", "azure"]))).toBe(false);
  });

  it("should be onboarded with no Atlassian, Jenkins, CLAUDE.md or git identity stored, since none of those is needed", () => {
    expect(onboarded(["github", "azure", "claude"], new Set(["github", "azure", "claude"]))).toBe(true);
  });
});

describe("connectionsAsk", () => {
  it("should ask for the accounts when none of the needed credentials is stored", () => {
    expect(connectionsAsk(false, null)).toBe("connect");
  });

  it("should ask for nothing when every needed credential is stored", () => {
    expect(connectionsAsk(true, null)).toBe("done");
  });

  it("should not ask for the accounts when the hub could not read the credentials it judged that on", () => {
    expect(connectionsAsk(false, "this deployment has no credentials vault")).toBe("unknown");
  });
});
