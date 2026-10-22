// What a pod sets as its git identity, against fake gh, az and git commands and a hub holding the owner's
// optional override.
import { describe, expect, it } from "vitest";
import { type Api, ApiError } from "./api.ts";
import { type ChosenIdentity, type Exec, type ExecResult, parseOverride, setGitIdentity } from "./git-identity.ts";

const HMCTS = "olive.owner@justice.gov.uk";
const USER = { login: "oliveo", id: 4242, name: "Olive Owner", email: null };
const NOREPLY = "4242+oliveo@users.noreply.github.com";

const ok = (value: unknown): ExecResult => ({ code: 0, stdout: `${JSON.stringify(value)}\n` });
const fail = (): ExecResult => ({ code: 1, stdout: "" });

type IdentifyOptions = {
  stored?: string | null;
  hubError?: Error | null;
  user?: ExecResult;
  emails?: ExecResult;
  az?: ExecResult;
  existing?: Record<string, string>;
  gitFails?: string[];
};

type IdentifyResult = {
  config: Record<string, string>;
  calls: string[];
  logs: string;
  chosen: ChosenIdentity | null;
  error: Error | null;
};

/** Runs setGitIdentity against fake gh, az and git, and a hub holding `stored` (or throwing `hubError`). */
async function identify({
  stored = null,
  hubError = null,
  user = ok(USER),
  emails = ok([]),
  az = ok({ mail: HMCTS, upn: "olive.owner@hmcts.net", name: "Owner, Olive" }),
  existing = {},
  gitFails = []
}: IdentifyOptions = {}): Promise<IdentifyResult> {
  const config: Record<string, string> = { ...existing };
  const calls: string[] = [];
  const logs: string[] = [];
  const credentialCalls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "gh" && args[1] === "user") {
      return user;
    }
    if (cmd === "gh" && args[1] === "user/emails") {
      return emails;
    }
    if (cmd === "az") {
      return az;
    }
    if (cmd === "git" && args[2] === "--get") {
      const key = args[3] as string;
      return config[key] ? { code: 0, stdout: `${config[key]}\n` } : { code: 1, stdout: "" };
    }
    if (cmd === "git") {
      const key = args[2] as string;
      if (gitFails.includes(key)) {
        return fail();
      }
      config[key] = args[3] as string;
      return { code: 0, stdout: "" };
    }
    throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
  };
  const api: Pick<Api, "getCredential"> = {
    getCredential: async (id, kind) => {
      credentialCalls.push(`${id}/${kind}`);
      if (hubError) {
        throw hubError;
      }
      return stored;
    }
  };
  let error: Error | null = null;
  let chosen: ChosenIdentity | null = null;
  try {
    chosen = await setGitIdentity({ api, id: "va-1", exec, log: (m) => logs.push(m) });
  } catch (e) {
    error = e as Error;
  }
  expect(credentialCalls.every((c) => c === "va-1/git_identity")).toBe(true);
  return { config, calls, logs: logs.join("\n"), chosen, error };
}

describe("setGitIdentity", () => {
  it("should use the stored name and email when the owner has set both on agent-hub", async () => {
    // Act
    const r = await identify({ stored: JSON.stringify({ name: "O. Owner", email: "olive@example.com" }), emails: ok([{ email: HMCTS, verified: true }]) });

    // Assert
    expect(r.config["user.name"]).toBe("O. Owner");
    expect(r.config["user.email"]).toBe("olive@example.com");
    expect(r.logs).toMatch(/user\.email olive@example\.com \(stored on agent-hub\)/);
  });

  it("should use the stored email and the GitHub name when only the email is stored", async () => {
    // Act
    const r = await identify({ stored: JSON.stringify({ email: "olive@example.com" }) });

    // Assert
    expect(r.config["user.name"]).toBe("Olive Owner");
    expect(r.config["user.email"]).toBe("olive@example.com");
  });

  it("should use the HMCTS email when GitHub lists it as verified", async () => {
    // Act
    const r = await identify({
      emails: ok([
        { email: "other@example.com", verified: true },
        { email: HMCTS.toUpperCase(), verified: true, primary: false }
      ])
    });

    // Assert
    expect(r.config["user.email"]).toBe(HMCTS);
    expect(r.logs).toMatch(/verified on the GitHub account/);
  });

  it("should not use the HMCTS email when GitHub lists it but not as verified", async () => {
    // Act
    const r = await identify({ emails: ok([{ email: HMCTS, verified: false }]) });

    // Assert
    expect(r.config["user.email"]).toBe(NOREPLY);
    expect(r.logs).toMatch(/is not a verified email on the GitHub account/);
  });

  it("should use the HMCTS email when it is the public email and the token cannot list emails", async () => {
    // Act
    const r = await identify({ user: ok({ ...USER, email: HMCTS }), emails: fail() });

    // Assert
    expect(r.config["user.email"]).toBe(HMCTS);
    expect(r.logs).toMatch(/public email/);
  });

  it("should use the noreply address and say the scope is missing when the token cannot list emails", async () => {
    // Act
    const r = await identify({ emails: fail() });

    // Assert
    expect(r.config["user.email"]).toBe(NOREPLY);
    expect(r.logs).toMatch(/no user:email scope/);
  });

  it("should use the userPrincipalName as the HMCTS email when az has no mail", async () => {
    // Act
    const r = await identify({ az: ok({ mail: null, upn: "olive.owner@hmcts.net" }), emails: ok([{ email: "olive.owner@hmcts.net", verified: true }]) });

    // Assert
    expect(r.config["user.email"]).toBe("olive.owner@hmcts.net");
  });

  it("should use the noreply address when az gives no email", async () => {
    // Act
    const r = await identify({ az: fail() });

    // Assert
    expect(r.config["user.email"]).toBe(NOREPLY);
    expect(r.logs).toMatch(/az gave no HMCTS email/);
  });

  it("should use the GitHub login as the name when the profile has no name", async () => {
    // Act
    const r = await identify({ user: ok({ ...USER, name: "  " }) });

    // Assert
    expect(r.config["user.name"]).toBe("oliveo");
  });

  it("should keep the configured identity when GitHub cannot be reached", async () => {
    // Act
    const r = await identify({ user: fail(), existing: { "user.name": "Before", "user.email": "before@example.com" } });

    // Assert
    expect(r.config["user.name"]).toBe("Before");
    expect(r.config["user.email"]).toBe("before@example.com");
    expect(r.calls).not.toContain("gh api user/emails");
    expect(r.logs).toMatch(/kept; GitHub could not be reached/);
  });

  it("should use the HMCTS email and Azure name when GitHub cannot be reached and nothing is configured", async () => {
    // Act
    const r = await identify({ user: fail() });

    // Assert
    expect(r.config["user.name"]).toBe("Owner, Olive");
    expect(r.config["user.email"]).toBe(HMCTS);
  });

  it("should keep the configured identity when agent-hub cannot be read", async () => {
    // Act
    const r = await identify({
      hubError: new ApiError(400, { error: "bad" }, "GET", "/api/virtual/va-1/credentials/git_identity"),
      existing: { "user.name": "Kept", "user.email": "kept@example.com" },
      emails: ok([{ email: HMCTS, verified: true }])
    });

    // Assert
    expect(r.config["user.name"]).toBe("Kept");
    expect(r.config["user.email"]).toBe("kept@example.com");
    expect(r.logs).toMatch(/could not read the git_identity credential/);
    expect(r.logs).toMatch(/kept; agent-hub could not be read/);
  });

  it("should fall back to the defaults when agent-hub cannot be read and nothing is configured", async () => {
    // Act
    const r = await identify({
      hubError: new ApiError(400, { error: "bad" }, "GET", "/api/virtual/va-1/credentials/git_identity"),
      emails: ok([{ email: HMCTS, verified: true }])
    });

    // Assert
    expect(r.config["user.name"]).toBe("Olive Owner");
    expect(r.config["user.email"]).toBe(HMCTS);
  });

  it("should set push.autoSetupRemote and init.defaultBranch when it sets the identity", async () => {
    // Act
    const r = await identify();

    // Assert
    expect(r.config["push.autoSetupRemote"]).toBe("true");
    expect(r.config["init.defaultBranch"]).toBe("master");
    expect(Object.keys(r.config).sort((a, b) => a.localeCompare(b))).toEqual(["init.defaultBranch", "push.autoSetupRemote", "user.email", "user.name"]);
  });

  it("should throw naming the keys when git config fails", async () => {
    // Act
    const r = await identify({ gitFails: ["user.email"] });

    // Assert
    expect(r.error?.message ?? "").toMatch(/user\.email/);
    expect(r.config["user.name"]).toBe("Olive Owner");
  });

  it("should leave both unset when neither GitHub nor Azure nor the existing config says anything", async () => {
    // Act
    const r = await identify({ user: fail(), az: fail() });

    // Assert
    expect(r.chosen).toEqual({ name: null, nameWhy: null, email: null, emailWhy: null });
    expect(r.logs).toMatch(/no user\.name could be found; leaving it unset/);
    expect(r.logs).toMatch(/no user\.email could be found; leaving it unset/);
    expect(r.config).toEqual({ "push.autoSetupRemote": "true", "init.defaultBranch": "master" });
  });
});

describe("parseOverride", () => {
  it("should ignore a stored override when it is not a JSON object of strings", () => {
    // Act & Assert
    expect(parseOverride("not json")).toEqual({});
    expect(parseOverride("[1]")).toEqual({});
    expect(parseOverride("null")).toEqual({});
    expect(parseOverride(JSON.stringify({ name: 7, email: " a@b.c " }))).toEqual({ name: null, email: "a@b.c" });
  });

  it("should be empty when nothing is stored", () => {
    // Act & Assert
    expect(parseOverride(null)).toEqual({});
    expect(parseOverride("")).toEqual({});
  });
});
