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
  GITHUB_SIGN_IN_CODES,
  ghLoginExpired,
  githubLogin,
  OUTPUT_TAIL_CHARS,
  outputTail,
  parseAzDeviceCode,
  parseClaudeAuthorizeUrl,
  parseGhDeviceCode,
  REDACTED,
  type RelayDeviceLoginResult,
  redactTokens,
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
  v.loginFailures.length = 0;
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

describe("redactTokens", () => {
  it("should replace a prefixed GitHub token and a classic one when both are in the text", () => {
    // Arrange: built here rather than written out, as every secret-shaped value in this suite is.
    const prefixed = `${"gh"}u_${"Q7w8E9r0".repeat(3)}`;
    const classic = "a".repeat(20) + "9".repeat(20);

    // Act
    const redacted = redactTokens(`signed in with ${prefixed} and ${classic}`);

    // Assert
    expect(redacted).toBe(`signed in with ${REDACTED} and ${REDACTED}`);
  });

  it("should keep the device code and the reason a sign-in failed, which are what the log is read for", () => {
    // Act & Assert
    expect(redactTokens("! First copy your one-time code: 7B7F-C198")).toBe("! First copy your one-time code: 7B7F-C198");
    expect(redactTokens("error: HTTP 429 (slow_down)")).toBe("error: HTTP 429 (slow_down)");
  });

  it("should replace every other kind the hub stores, because relayDeviceLogin quotes output for all of them", () => {
    // Arrange: `az` and `twg` go through the same helper as `gh`, so a list that knew GitHub's shapes alone
    // would be a safety net for one caller in three.
    const jwt = `${"eyJ"}hbGciOiJSUzI1NiJ9.${"eyJ"}zdWIiOiJvbGl2ZSJ9.${"S1gn4tur3"}_${"Zy3"}`;

    // Act & Assert
    expect(redactTokens(`token=${CLAUDE_TOKEN}`)).toBe(`token=${REDACTED}`);
    expect(redactTokens(`oauth-refresh-token=${podSecrets.twgRefresh}`)).toBe(`oauth-refresh-token=${REDACTED}`);
    expect(redactTokens(`oauth-access-token=${podSecrets.twgAccess}`)).toBe(`oauth-access-token=${REDACTED}`);
    expect(redactTokens(`Bearer ${jwt}`)).toBe(`Bearer ${REDACTED}`);
  });
});

describe("ghLoginExpired", () => {
  it("should be true for the words gh uses when the code ran out, and false for a sign-in that broke", () => {
    // Act & Assert
    expect(ghLoginExpired("error: authentication timed out")).toBe(true);
    expect(ghLoginExpired("error: the device code has expired (expired_token)")).toBe(true);
    expect(ghLoginExpired("error: HTTP 429")).toBe(false);
    expect(ghLoginExpired(GH_OUTPUT)).toBe(false);
  });
});

describe("outputTail", () => {
  it("should give one line with the escapes gone and the whitespace collapsed", () => {
    // Act & Assert
    expect(outputTail("\x1b[1m! First copy\x1b[22m\n\n  your code\n")).toBe("! First copy your code");
  });

  it("should keep the end when the output is longer than the limit, because the reason is its last word", () => {
    // Act
    const tail = outputTail(`${"x".repeat(OUTPUT_TAIL_CHARS)} error: HTTP 429`);

    // Assert
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("error: HTTP 429")).toBe(true);
    expect(tail).toHaveLength(OUTPUT_TAIL_CHARS + 1);
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

  it("should store the token gh already holds without relaying a code when an earlier call signed it in", async () => {
    // Arrange: gh's config is a memory-backed emptyDir, so a token in it belongs to this pod — from a call that
    // signed in and then failed to store what it got. Asking GitHub again would ask the owner to repeat herself.
    fs.writeFileSync(path.join(pod.stateDir, "gh-token"), GH_TOKEN);

    // Act
    const { result, stderr } = await captureStderr(() => githubLogin({ api: api(), env: pod.env() }));

    // Assert
    expect(result).toBe("signed-in");
    expect(virtual().prompts).toEqual([]);
    expect(virtual().credentials.get("github")).toBe(GH_TOKEN);
    expect(stderr).not.toContain(GH_TOKEN);
  });

  it("should throw when gh signs in and then holds no token, which is this pod's fault and not the owner's", async () => {
    // Arrange: FAKE_GH_TOKEN unset, so the shim writes an empty token file and `gh auth token` succeeds with
    // nothing to say. The sign-in itself exited 0, so the owner did everything asked of them.
    // Act
    const { error } = await captureStderrOfFailure(() => githubLogin({ api: api(), env: pod.env() }));

    // Assert
    expect((error as Error).message).toMatch(/gh auth login exited 0 but gh auth token gave no token \(exit 0\)/);
    expect(virtual().loginFailures).toEqual([]);
    expect(virtual().credentials.has("github")).toBe(false);
  });

  it("should relay a fresh code on a later call, which is what keeps a dead one off the owner's screen", async () => {
    // Arrange: a sign-in nobody completed ends the call, and an owner who stops and starts the agent gets a new
    // pod and a new call. Each code replaces the one before it on their screen, so no code outlives its time.
    await captureStderr(() => githubLogin({ api: api(), env: pod.env({ FAKE_GH_LOGIN_FAILS: "error: HTTP 429" }), codes: 1 }));

    // Act
    await captureStderr(() => githubLogin({ api: api(), env: pod.env({ FAKE_GH_TOKEN: GH_TOKEN }) }));

    // Assert
    expect(virtual().prompts.filter((prompt) => prompt.kind === "github")).toHaveLength(2);
    expect(virtual().credentials.get("github")).toBe(GH_TOKEN);
  });

  it("should log what gh said, with any token redacted, when the sign-in breaks", async () => {
    // Arrange: gh's own words are the only record of why a poll stopped. The token shape must not survive them;
    // the reason must. Both are built here, as every secret-shaped value in this suite is.
    const leaked = `${"github"}_pat_${"L3ak3d_T0k3n".repeat(2)}`;
    const reason = `error: HTTP 429 and a token ${leaked} it should not have printed`;

    // Act
    const { stderr } = await captureStderr(() => githubLogin({ api: api(), env: pod.env({ FAKE_GH_LOGIN_FAILS: reason }) }));

    // Assert
    expect(stderr).toContain("gh said:");
    expect(stderr).toContain("error: HTTP 429");
    expect(stderr).toContain(REDACTED);
    expect(stderr).not.toContain(leaked);
  });

  it("should spend every code and report the sign-in failed when GitHub answers the poll with a fault", async () => {
    // Arrange: a fault is the case this exists for, and may not last, so each code is a fresh chance at it. One
    // code and then silence would turn a single bad answer from GitHub into a pod that has stopped asking.
    // Act
    const { result } = await captureStderr(() => githubLogin({ api: api(), env: pod.env({ FAKE_GH_LOGIN_FAILS: "error: HTTP 429" }) }));

    // Assert
    expect(result).toBe("not-signed-in");
    expect(virtual().prompts.filter((prompt) => prompt.kind === "github")).toHaveLength(GITHUB_SIGN_IN_CODES);
    expect(virtual().loginFailures).toEqual([
      { kind: "github", state: "failed", detail: "github: GitHub stopped the sign-in before it could be completed, so the code is no longer any use" }
    ]);
  });

  it("should report the sign-in and stop asking when the relay fails after the hub already had the code", async () => {
    // Arrange: `loginPrompt` lands and the `virtualStatus` beside it is refused, so a live code is on the
    // owner's screen and the relay still fails. The hub is owed a `failed` for that code or it keeps a pending
    // row and the agent reads as waiting for them; and the owner has been asked, so a caller must not retry
    // without bound and put a fresh code there on every pass. 400 rather than 500, so `withRetry` does not.
    hub.failNextStatuses(1, 400);

    // Act
    const { result } = await captureStderr(() => githubLogin({ api: api(), env: pod.env({ FAKE_GH_TOKEN: GH_TOKEN }) }));

    // Assert
    expect(result).toBe("not-signed-in");
    expect(virtual().prompts.filter((prompt) => prompt.kind === "github")).toHaveLength(1);
    expect(virtual().loginFailures).toEqual([
      { kind: "github", state: "failed", detail: "github: the sign-in could not be finished; start the agent again to be sent another code" }
    ]);
  });

  it("should stop at its budget of codes and report the sign-in expired when gh says each one timed out", async () => {
    // Arrange: `expiresIn` is left at its full fifteen minutes and the shim exits at once, so the clock alone
    // would call every attempt a break. gh naming the outcome is what earns the next code.
    // Act
    const { result, stderr } = await captureStderr(() => githubLogin({ api: api(), env: pod.env({ FAKE_GH_LOGIN_FAILS: "error: authentication timed out" }) }));

    // Assert
    expect(result).toBe("not-signed-in");
    expect(virtual().prompts.filter((prompt) => prompt.kind === "github")).toHaveLength(GITHUB_SIGN_IN_CODES);
    expect(virtual().loginFailures).toEqual([
      { kind: "github", state: "expired", detail: "github: the sign-in code ran out before it was used; start the agent again to be sent another" }
    ]);
    expect(stderr).toContain("authentication timed out");
  });

  it("should throw rather than report the owner at fault when gh prints no code for them at all", async () => {
    // Arrange: gh fails before printing a code, so the owner was shown nothing and was never asked. Throwing is
    // what has the caller ride it out; reporting it would tell somebody they did not do what nobody asked of them.
    // Act
    const { error, stderr } = await captureStderrOfFailure(() =>
      githubLogin({ api: api(), env: pod.env({ FAKE_GH_LOGIN_CRASHES: "error: could not reach github.com" }) })
    );

    // Assert
    expect((error as Error).message).toMatch(/gh printed no sign-in code \(exit 1\)/);
    expect((error as Error).message).toContain("could not reach github.com");
    expect(virtual().prompts).toEqual([]);
    expect(virtual().loginFailures).toEqual([]);
    // Nothing was shown, so there is nothing to withdraw, and saying the hub could not be told would be noise
    // about a sign-in it never had.
    expect(stderr).not.toMatch(/could not tell agent-hub/);
  });

  it("should throw and name the exit code when gh auth token cannot be run at all", async () => {
    // Arrange: exit 127 is what `run` answers for a command it could not spawn, and 1 for one it killed at the
    // timeout. Neither is an answer about the owner, so neither may be read as a token gh does not hold.
    // Act
    const { error } = await captureStderrOfFailure(() => githubLogin({ api: api(), env: pod.env({ FAKE_GH_TOKEN_UNREADABLE: "1" }) }));

    // Assert
    expect((error as Error).message).toMatch(/gh auth token gave no token \(exit 127\)/);
    expect(virtual().loginFailures).toEqual([]);
  });

  it("should throw rather than report a failed sign-in when the hub cannot be given a token gh did grant", async () => {
    // Arrange: the owner completed the sign-in and the store is what failed, so the sign-in did not fail and
    // they have nothing left to do. Reporting one would withdraw the code they used and ask them to paste the
    // token they have just authorised.
    hub.failNextCredentialPuts(1, 400);

    // Act
    const { error } = await captureStderrOfFailure(() => githubLogin({ api: api(), env: pod.env({ FAKE_GH_TOKEN: GH_TOKEN }) }));

    // Assert
    expect(error).toBeInstanceOf(ApiError);
    expect(virtual().completes).toEqual([{ kind: "github", account_label: "octocat" }]);
    expect(virtual().loginFailures).toEqual([]);
    expect(virtual().credentials.has("github")).toBe(false);
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
