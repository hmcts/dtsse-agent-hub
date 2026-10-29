import { describe, expect, it } from "vitest";
import type { CredentialKind } from "../credentials/names.ts";
import { neededCredentials } from "../virtual-agents/views.ts";
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
  it("should be onboarded without Azure when the own-licence route's needed credentials are stored", () => {
    expect(onboarded(neededCredentials("own-licence"), new Set(["github", "claude"]))).toBe(true);
  });

  // The gateway authorises the person, so their Azure sign-in is this route's model credential rather than an extra.
  it("should want Azure, and no model key, before an assistant on the gateway route is onboarded", () => {
    expect(onboarded(neededCredentials("gateway"), new Set(["github"]))).toBe(false);
    expect(onboarded(neededCredentials("gateway"), new Set(["github", "azure"]))).toBe(true);
  });

  it("should be onboarded when every needed credential is stored", () => {
    expect(onboarded(["github", "azure", "claude"], new Set(["github", "azure", "claude", "jenkins"]))).toBe(true);
  });

  it("should not be onboarded when a needed credential is missing", () => {
    expect(onboarded(["github", "azure", "claude"], new Set(["github", "azure"]))).toBe(false);
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
    expect(chatCredentials(["github", "azure", "claude"], "own-licence")).toEqual(["github", "claude"]);
  });

  // The gateway authorises the person rather than a key, so a pod whose apiKeyHelper has no sign-in to mint from
  // fails every turn: Azure is the model credential there, and a chat opened without it is a chat that cannot work.
  it("should need GitHub and Azure when the assistant runs on the gateway, where Azure is the model credential", () => {
    expect(chatCredentials(neededCredentials("gateway"), "gateway")).toEqual(["github", "azure"]);
  });

  it("should leave Azure out of the gate when the assistant runs on the person's own licence", () => {
    expect(chatCredentials([...neededCredentials("own-licence"), "azure"], "own-licence")).not.toContain("azure");
  });
});

describe("chatGate", () => {
  const OWN_LICENCE: CredentialKind[] = ["github", "claude"];
  const GATEWAY: CredentialKind[] = ["github", "azure"];

  it.each([
    ["neither GitHub nor Claude is stored", OWN_LICENCE, ["azure"]],
    ["GitHub is stored and Claude is not", OWN_LICENCE, ["github", "azure"]],
    ["Claude is stored and GitHub is not", OWN_LICENCE, ["claude", "azure"]],
    ["neither GitHub nor Azure is stored and the assistant runs on the gateway", GATEWAY, ["claude"]],
    ["a Claude token is stored and the assistant runs on the gateway", GATEWAY, ["github", "claude"]]
  ] as const)("should be blocked when %s", (_, toChat, stored) => {
    expect(chatGate(toChat, new Set<CredentialKind>(stored), null)).toBe("blocked");
  });

  it("should be open when GitHub and the assistant's model key are stored, even without Azure", () => {
    expect(chatGate(OWN_LICENCE, new Set(["github", "claude"]), null)).toBe("open");
  });

  it("should be open when the hub cannot read the credentials it would judge that on", () => {
    expect(chatGate(OWN_LICENCE, new Set(), "this deployment has no credentials vault")).toBe("open");
  });
});
