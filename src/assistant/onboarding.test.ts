import { describe, expect, it } from "vitest";
import type { CredentialKind } from "../credentials/names.ts";
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
  it("should need GitHub, Azure and a Claude token when the assistant runs on the person's own licence", () => {
    expect(chatCredentials(["github", "azure", "claude"])).toEqual(["github", "azure", "claude"]);
  });

  it("should need GitHub, Azure and a Bedrock API key when the assistant runs on Amazon Bedrock", () => {
    expect(chatCredentials(["github", "azure", "bedrock"])).toEqual(["github", "azure", "bedrock"]);
  });
});

describe("chatGate", () => {
  const OWN_LICENCE: CredentialKind[] = ["github", "azure", "claude"];
  const BEDROCK: CredentialKind[] = ["github", "azure", "bedrock"];

  it.each([
    ["nothing is stored", OWN_LICENCE, []],
    ["GitHub and Azure are stored and Claude is not", OWN_LICENCE, ["github", "azure"]],
    ["Claude and Azure are stored and GitHub is not", OWN_LICENCE, ["claude", "azure"]],
    ["GitHub and Claude are stored and Azure is not", OWN_LICENCE, ["github", "claude"]],
    ["GitHub and a Bedrock key are stored and Azure is not", BEDROCK, ["github", "bedrock"]],
    ["a Claude token is stored and the assistant runs on Bedrock", BEDROCK, ["github", "azure", "claude"]],
    ["a Bedrock key is stored and the assistant runs on the person's own licence", OWN_LICENCE, ["github", "azure", "bedrock"]]
  ] as const)("should be blocked when %s", (_, toChat, stored) => {
    expect(chatGate(toChat, new Set<CredentialKind>(stored), null)).toBe("blocked");
  });

  it("should be open when GitHub, Azure and the assistant's model key are stored, without the optional ones", () => {
    expect(chatGate(OWN_LICENCE, new Set(["github", "azure", "claude"]), null)).toBe("open");
    expect(chatGate(BEDROCK, new Set(["github", "azure", "bedrock"]), null)).toBe("open");
  });

  it("should be open when the hub cannot read the credentials it would judge that on", () => {
    expect(chatGate(OWN_LICENCE, new Set(), "this deployment has no credentials vault")).toBe("open");
  });
});
