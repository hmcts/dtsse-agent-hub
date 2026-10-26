// The sign-ins a pod relays to its owner, against the mock hub with fake az, gh and script(1) on PATH that
// print what the real ones print. No real sign-in is ever started, and every assertion that a secret stays
// off stderr is kept from the workspace suite.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMockHub, type MockHub } from "../__fixtures__/mock-hub.ts";
import {
  AUTHORIZE_URL,
  AZ_OUTPUT,
  CLAUDE_OUTPUT,
  captureStderr,
  captureStderrOfFailure,
  createPodShims,
  GH_OUTPUT,
  msalCache,
  type PodShims,
  podSecrets,
  usePodEnv
} from "../__fixtures__/pod-shims.ts";
import { type Api, ApiError, createApi } from "../api.ts";
import { packAzureCache, pruneMsalCache, unpackAzureCache } from "./azure-cache.ts";
import { FatalError } from "./phases.ts";
import {
  azureLogin,
  claudeLogin,
  EXPIRY_TOLERANCE_S,
  findClaudeToken,
  githubLogin,
  parseAzDeviceCode,
  parseClaudeAuthorizeUrl,
  parseGhDeviceCode,
  type RelayDeviceLoginResult,
  relayDeviceLogin,
  run,
  stripAnsi
} from "./sign-in.ts";

const VID = "va-sign-in";
const OWNER = { oid: "oid-owner", name: "Olive Owner", email: "olive@example.com" };
const LAUNCH = podSecrets.launchToken;
const REFRESH = podSecrets.azureRefresh;
const GH_TOKEN = podSecrets.githubToken;
const CLAUDE_TOKEN = podSecrets.claudeToken;

let hub: MockHub;
let url: string;
let pod: PodShims;
let restoreEnv: () => void;

beforeAll(async () => {
  hub = createMockHub({ pingMs: 5000, launchTokens: { [LAUNCH]: { virtualId: VID, owner: OWNER } } });
  url = await hub.listen();
  pod = createPodShims({ virtualId: VID, hubUrl: url });
  restoreEnv = usePodEnv(pod.home);
});

afterEach(() => {
  const v = virtual();
  v.status.length = 0;
  v.prompts.length = 0;
  v.completes.length = 0;
  v.credentials.clear();
  v.codes.clear();
  pod.reset();
});

afterAll(async () => {
  await hub.close();
  restoreEnv();
  pod.cleanup();
});

const virtual = () => hub.virtuals.get(VID) as NonNullable<ReturnType<MockHub["virtuals"]["get"]>>;
const api = () => createApi({ baseUrl: url, launchToken: LAUNCH });
const azurePuts = () => hub.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/credentials/azure")).length;

describe("run", () => {
  it("should give exit 127 and the reason when the command is not on PATH", async () => {
    // Act
    const r = await run("definitely-not-a-command", [], { env: pod.env() });

    // Assert
    expect(r.code).toBe(127);
    expect(r.stderr).toMatch(/ENOENT/);
  });

  it("should feed stdin to the command and collect both streams when given input", async () => {
    // Act
    const r = await run("bash", ["-c", "cat; echo oops >&2"], { env: pod.env(), input: "hello" });

    // Assert
    expect(r).toEqual({ code: 0, stdout: "hello", stderr: "oops\n" });
  });

  it("should kill the command when it outruns the timeout", async () => {
    // Act
    const r = await run("bash", ["-c", "sleep 5"], { env: pod.env(), timeoutMs: 50 });

    // Assert: killed by a signal, so there is no exit code of its own.
    expect(r.code).toBe(1);
  });
});

describe("stripAnsi", () => {
  it("should remove OSC, CSI, charset and single-character escapes when given a TUI's output", () => {
    // Act & Assert
    expect(stripAnsi("\x1b]0;title\x07plain")).toBe("plain");
    expect(stripAnsi("\x1b[38;5;74mcoloured\x1b[39m")).toBe("coloured");
    expect(stripAnsi("\x1b(Bascii")).toBe("ascii");
    expect(stripAnsi("\x1b=\x1b>\x1b7\x1b8kept")).toBe("kept");
  });
});

describe("parseAzDeviceCode", () => {
  it("should read the page and the code out of what az prints", () => {
    // Act & Assert
    expect(parseAzDeviceCode(AZ_OUTPUT)).toEqual({ verification_uri: "https://login.microsoft.com/device", user_code: "LNKR6UHMN" });
  });

  it("should read them out of the WARNING-prefixed line az prints against the other endpoint", () => {
    // Act & Assert
    expect(
      parseAzDeviceCode(
        "WARNING: To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code F4XQ9ZK2L to authenticate."
      )
    ).toEqual({ verification_uri: "https://microsoft.com/devicelogin", user_code: "F4XQ9ZK2L" });
  });

  it("should be null when only half the line has been printed", () => {
    // Act & Assert
    expect(parseAzDeviceCode("To sign in, use a web browser to open the page")).toBeNull();
  });
});

describe("parseGhDeviceCode", () => {
  it("should read the device page and the one-time code out of what gh prints", () => {
    // Act & Assert
    expect(parseGhDeviceCode(GH_OUTPUT)).toEqual({ verification_uri: "https://github.com/login/device", user_code: "7B7F-C198" });
  });

  it("should be null until the URL is printed too", () => {
    // Act & Assert
    expect(parseGhDeviceCode("! First copy your one-time code: 7B7F-C198\n")).toBeNull();
  });
});

describe("parseClaudeAuthorizeUrl", () => {
  it("should take the URL from the OSC 8 hyperlink when setup-token draws its TUI", () => {
    // Act & Assert
    expect(parseClaudeAuthorizeUrl(CLAUDE_OUTPUT)).toBe(AUTHORIZE_URL);
  });

  it("should take it from the plain text when there is no hyperlink", () => {
    // Act & Assert
    expect(parseClaudeAuthorizeUrl(`\x1b[2mUse the url below\x1b[22m\r\n${AUTHORIZE_URL}\r\n`)).toBe(AUTHORIZE_URL);
  });

  it("should be null when nothing like a sign-in link has been printed", () => {
    // Act & Assert
    expect(parseClaudeAuthorizeUrl("Opening browser to sign in…")).toBeNull();
  });
});

describe("findClaudeToken", () => {
  it("should find the token through the TUI's bold escapes when setup-token prints one", () => {
    // Act & Assert
    expect(findClaudeToken(`Your OAuth token:\r\n \x1b[1m${CLAUDE_TOKEN}\x1b[22m\r\n`)).toBe(CLAUDE_TOKEN);
  });

  it("should be null while only the sign-in prompt has been printed", () => {
    // Act & Assert
    expect(findClaudeToken(CLAUDE_OUTPUT)).toBeNull();
  });
});

describe("relayDeviceLogin", () => {
  it("should reject with the reason when the command cannot start", async () => {
    // Act
    const error = await relayDeviceLogin({
      api: api(),
      id: VID,
      kind: "github",
      cmd: "definitely-not-a-command",
      args: [],
      env: pod.env(),
      parse: () => null,
      label: "github"
    }).catch((e: unknown) => e);

    // Assert
    expect((error as Error).message).toMatch(/definitely-not-a-command could not start: .*ENOENT/);
  });

  it("should stop the command and reject when the code cannot be relayed to the hub", async () => {
    // Arrange: the hub refuses the relay outright, so the owner would never see the code. A 400 is not a
    // retryable status, so `withRetry` gives up on the first attempt.
    const failing: Pick<Api, "loginPrompt" | "virtualStatus"> = {
      loginPrompt: async () => {
        throw new ApiError(400, { error: "hub down" }, "POST", `/api/virtual/${VID}/login/github`);
      },
      virtualStatus: async () => null
    };

    // Act
    const { error, stderr } = await captureStderrOfFailure(() =>
      relayDeviceLogin({
        api: failing,
        id: VID,
        kind: "github",
        cmd: "bash",
        args: ["-c", `printf '%s' ${JSON.stringify(GH_OUTPUT)}; sleep 30`],
        env: pod.env(),
        parse: parseGhDeviceCode,
        expiresIn: 1,
        label: "github"
      })
    );

    // Assert
    expect((error as Error).message).toMatch(/^could not relay the github sign-in code: POST .*400 hub down$/);
    expect(stderr).toBe("");
  });

  function relay(script: string, options: Partial<Parameters<typeof relayDeviceLogin>[0]> = {}): Promise<RelayDeviceLoginResult> {
    return relayDeviceLogin({
      api: api(),
      id: VID,
      kind: "github",
      cmd: "bash",
      args: ["-c", `printf '%s' ${JSON.stringify(GH_OUTPUT)}; ${script}`],
      env: pod.env(),
      parse: parseGhDeviceCode,
      label: "github",
      ...options
    });
  }

  it("should call the code expired when it was on the owner's screen until its time ran out", async () => {
    // Act
    const result = await relay("sleep 1.2; exit 1", { expiresIn: 1 });

    // Assert
    expect(result).toMatchObject({ code: 1, expired: true });
  });

  it("should allow the tolerance, because the code was already running when we first saw it", async () => {
    // Arrange: a command that gives up this far short of `expiresIn` did so because the code ran out, not because
    // the sign-in broke; our clock starts when the code is parsed, which is after the command started its own.
    // Act
    const result = await relay("exit 1", { expiresIn: EXPIRY_TOLERANCE_S });

    // Assert
    expect(result).toMatchObject({ code: 1, expired: true });
  });

  it("should not call it expired when the command gave up well inside the code's life", async () => {
    // Act
    const result = await relay("exit 1", { expiresIn: EXPIRY_TOLERANCE_S + 30 });

    // Assert
    expect(result).toMatchObject({ code: 1, expired: false });
  });

  it("should take the command's own word for it when it says the code ran out", async () => {
    // Act: nothing has waited, so only `isExpiry` can be the reason
    const result = await relay("echo 'gave up [login_timeout]'; exit 1", {
      expiresIn: 900,
      isExpiry: (output) => /\[login_timeout\]/.test(output)
    });

    // Assert
    expect(result).toMatchObject({ code: 1, expired: true });
  });
});

describe("azureLogin", () => {
  it("should restore a stored cache that still works and sign in no one", async () => {
    // Arrange
    const before = azurePuts();
    await api().putCredential(VID, "azure", packAzureCache(JSON.stringify(msalCache())).value);
    fs.writeFileSync(path.join(pod.stateDir, "az-ok"), "");

    // Act
    const { result } = await captureStderr(() => azureLogin({ api: api(), env: pod.env() }));

    // Assert
    expect(result).toBe("restored");
    expect(virtual().prompts).toHaveLength(0);
    expect(azurePuts() - before).toBe(1);
  });

  it("should relay the device code, complete with the account and store the pruned cache when nothing is stored", async () => {
    // Act
    const { result, stderr } = await captureStderr(() => azureLogin({ api: api(), env: pod.env() }));

    // Assert
    expect(result).toBe("signed-in");
    expect(virtual().prompts).toEqual([
      { kind: "azure", prompt: "device_code", verification_uri: "https://login.microsoft.com/device", user_code: "LNKR6UHMN", expires_in: 900 }
    ]);
    expect(virtual().status[0]?.phase).toBe("awaiting_login");
    expect(virtual().completes).toEqual([{ kind: "azure", account_oid: OWNER.oid, account_label: "olive@hmcts.net" }]);
    expect(unpackAzureCache(virtual().credentials.get("azure") as string)).toEqual(pruneMsalCache(msalCache()));
    expect(hub.calls.find((c) => c.path === `/api/virtual/${VID}/login/azure`)?.headers.authorization).toBe(`Bearer ${LAUNCH}`);
    expect(stderr).not.toContain(REFRESH);
    expect(stderr).not.toContain(LAUNCH);
  });

  it("should fail for good and wipe the local sign-in when the hub says the account is not the owner", async () => {
    // Arrange
    const env = pod.env({ SHIM_OID: "oid-intruder" });

    // Act
    const { error } = await captureStderrOfFailure(() => azureLogin({ api: api(), env }));

    // Assert
    expect(error).toBeInstanceOf(FatalError);
    expect(virtual().credentials.has("azure")).toBe(false);
    expect(fs.existsSync(env.AZURE_CONFIG_DIR as string)).toBe(false);
    expect(virtual().status.at(-1)?.phase).toBe("failed");
  });

  it("should sign in again when the stored cache no longer works", async () => {
    // Arrange: no `az-ok`, so the restored sign-in fails `az account get-access-token`.
    await api().putCredential(VID, "azure", packAzureCache(JSON.stringify(msalCache())).value);

    // Act
    const { result, stderr } = await captureStderr(() => azureLogin({ api: api(), env: pod.env() }));

    // Assert
    expect(result).toBe("signed-in");
    expect(stderr).toContain("azure: the stored sign-in no longer works; signing in again");
    expect(virtual().prompts).toHaveLength(1);
  });

  it("should sign in again when the stored cache cannot be restored at all", async () => {
    // Arrange
    await api().putCredential(VID, "azure", "not a gzipped cache");

    // Act
    const { result, stderr } = await captureStderr(() => azureLogin({ api: api(), env: pod.env() }));

    // Assert
    expect(result).toBe("signed-in");
    expect(stderr).toMatch(/azure: could not restore the stored sign-in \(.*\); signing in again/);
  });
});

describe("githubLogin", () => {
  it("should relay the device code without a browser and store the token", async () => {
    // Act
    const { result, stderr } = await captureStderr(() => githubLogin({ api: api(), env: pod.env({ FAKE_GH_TOKEN: GH_TOKEN, GH_TOKEN: "stale" }) }));

    // Assert
    expect(result).toBe("signed-in");
    expect(virtual().prompts).toEqual([
      { kind: "github", prompt: "device_code", verification_uri: "https://github.com/login/device", user_code: "7B7F-C198", expires_in: 900 }
    ]);
    expect(virtual().completes).toEqual([{ kind: "github", account_label: "octocat" }]);
    expect(fs.readFileSync(path.join(pod.stateDir, "gh-login-args"), "utf8")).toMatch(/--scopes user:email --web/);
    expect(virtual().credentials.get("github")).toBe(GH_TOKEN);
    expect(stderr).not.toContain(GH_TOKEN);
  });

  it("should fail when gh completes the sign-in but holds no token", async () => {
    // Arrange: FAKE_GH_TOKEN unset, so the shim writes an empty token file.
    // Act
    const { error } = await captureStderrOfFailure(() => githubLogin({ api: api(), env: pod.env() }));

    // Assert
    expect((error as Error).message).toMatch(/gh auth login exited 0 without a token/);
    expect(virtual().credentials.has("github")).toBe(false);
  });

  it("should relay a fresh code on every call, which is what keeps a dead one off the owner's screen", async () => {
    // Arrange: a failed GitHub sign-in throws, and `virtual-agent-boot` calls this again until it works. The
    // relay is what Atlassian's lacks: a new code replaces the old one, so no code outlives its own time by long.
    await captureStderrOfFailure(() => githubLogin({ api: api(), env: pod.env() }));

    // Act
    await captureStderr(() => githubLogin({ api: api(), env: pod.env({ FAKE_GH_TOKEN: GH_TOKEN }) }));

    // Assert
    expect(virtual().prompts.filter((prompt) => prompt.kind === "github")).toHaveLength(2);
  });
});

describe("claudeLogin", () => {
  it("should relay the authorize URL, type the pasted code into the TUI and store the token", async () => {
    // Arrange
    virtual().codes.set("claude", "good-code#state");

    // Act
    const { result, stderr } = await captureStderr(() => claudeLogin({ api: api(), env: pod.env({ FAKE_CLAUDE_TOKEN: CLAUDE_TOKEN }), pollMs: 50 }));

    // Assert
    expect(result).toBe("signed-in");
    expect(virtual().prompts).toEqual([{ kind: "claude", prompt: "paste_code", verification_uri: AUTHORIZE_URL, expires_in: 600 }]);
    expect(virtual().completes).toEqual([{ kind: "claude" }]);
    expect(virtual().credentials.get("claude")).toBe(CLAUDE_TOKEN);
    expect(stderr).not.toContain(CLAUDE_TOKEN);
  });

  it("should do nothing when the hub already holds a token", async () => {
    // Arrange
    virtual().credentials.set("claude", CLAUDE_TOKEN);

    // Act
    const result = await claudeLogin({ api: api(), env: pod.env() });

    // Assert
    expect(result).toBe("stored");
    expect(virtual().prompts).toHaveLength(0);
  });

  it("should fall back to waiting for a token stored on the hub when no URL appears", async () => {
    // Arrange
    pod.shim("script", "sleep 30");
    try {
      setTimeout(() => virtual().credentials.set("claude", CLAUDE_TOKEN), 400);

      // Act
      const { result } = await captureStderr(() => claudeLogin({ api: api(), env: pod.env(), pollMs: 50, fallbackPollMs: 50, urlTimeoutMs: 200 }));

      // Assert
      expect(result).toBe("stored");
      expect(virtual().status.at(-1)?.phase).toBe("awaiting_credentials");
      expect(virtual().status.at(-1)?.detail).toMatch(/settings\/credentials/);
    } finally {
      pod.scriptShim();
    }
  });

  it("should fail when the TUI rejects the pasted code and prints no token", async () => {
    // Arrange: the fake script(1) exits non-zero on a code it does not accept.
    virtual().codes.set("claude", "wrong-code");

    // Act
    const { error } = await captureStderrOfFailure(() =>
      claudeLogin({ api: api(), env: pod.env({ FAKE_CLAUDE_TOKEN: CLAUDE_TOKEN }), pollMs: 20, tokenTimeoutMs: 2000 })
    );

    // Assert
    expect((error as Error).message).toBe("claude: setup-token printed no token after the code was entered");
    expect(virtual().credentials.has("claude")).toBe(false);
  });

  it("should give up when setup-token exits before the owner pastes a code", async () => {
    // Arrange: the TUI prints its link and then gives up, and no code is ever stored.
    pod.shim("script", 'cat "$SHIM_STATE/claude.out"; sleep 1');
    try {
      // Act
      const { error } = await captureStderrOfFailure(() => claudeLogin({ api: api(), env: pod.env(), pollMs: 20 }));

      // Assert
      expect((error as Error).message).toBe("claude: no code was pasted before the sign-in expired");
      expect(virtual().prompts).toHaveLength(1);
    } finally {
      pod.scriptShim();
    }
  });
});
