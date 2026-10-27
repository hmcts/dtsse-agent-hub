import { describe, expect, it } from "vitest";
import { chatCredentials, chatGate, connectionsAsk, onboarded, readiness } from "./onboarding.ts";

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

describe("chatCredentials", () => {
  it("should need GitHub and a Claude token when the assistant runs on the person's own licence", () => {
    expect(chatCredentials(["github", "azure", "claude"])).toEqual(["github", "claude"]);
  });

  it("should need GitHub and a Bedrock API key when the assistant runs on Amazon Bedrock", () => {
    expect(chatCredentials(["github", "azure", "bedrock"])).toEqual(["github", "bedrock"]);
  });
});

describe("chatGate", () => {
  it("should be blocked when neither GitHub nor Claude is stored", () => {
    expect(chatGate(["github", "claude"], new Set(["azure"]), null)).toBe("blocked");
  });

  it("should be blocked when GitHub is stored and Claude is not", () => {
    expect(chatGate(["github", "claude"], new Set(["github", "azure"]), null)).toBe("blocked");
  });

  it("should be blocked when Claude is stored and GitHub is not", () => {
    expect(chatGate(["github", "claude"], new Set(["claude", "azure"]), null)).toBe("blocked");
  });

  it("should be blocked when a Claude token is stored and the assistant runs on Bedrock", () => {
    expect(chatGate(["github", "bedrock"], new Set(["github", "claude"]), null)).toBe("blocked");
  });

  it("should be blocked when a Bedrock key is stored and the assistant runs on the person's own licence", () => {
    expect(chatGate(["github", "claude"], new Set(["github", "bedrock"]), null)).toBe("blocked");
  });

  it("should be open when GitHub and the assistant's model key are stored, even without Azure", () => {
    expect(chatGate(["github", "claude"], new Set(["github", "claude"]), null)).toBe("open");
  });

  it("should be open when the hub cannot read the credentials it would judge that on", () => {
    expect(chatGate(["github", "claude"], new Set(), "this deployment has no credentials vault")).toBe("open");
  });
});
