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
  msalCache,
  type PodShims,
  podSecrets,
  usePodEnv
} from "../__fixtures__/pod-shims.ts";
import { type Api, ApiError, createApi } from "../api.ts";
import { jiraExportSignInBudget } from "./atlassian.ts";
import { packAzureCache, pruneMsalCache, unpackAzureCache } from "./azure-cache.ts";
import { FatalError } from "./phases.ts";
import {
  azureLogin,
  claudeLogin,
  EXPIRY_TOLERANCE_S,
  findClaudeToken,
  GITHUB_SIGN_IN_CODES,
  GITHUB_SIGN_IN_GAP_MS,
  type GithubLoginOptions,
  githubLogin,
  githubSignInGapMs,
  OUTPUT_TAIL_CHARS,
  outputTail,
  parseAzDeviceCode,
  parseClaudeAuthorizeUrl,
  REDACTED,
  type RelayDeviceLoginResult,
  redactTokens,
  relayDeviceLogin,
  run,
  SIGKILL_AFTER_MS,
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

  it("should answer for a command whose descendants hold its pipes open past the kill", async () => {
    // Arrange: the kill is certain and `close` is not — it waits for the pipes, and this leaves a subshell
    // holding them. Without the giving-up step the timeout bounds nothing and the caller waits for ever.
    // Act
    const started = Date.now();
    const r = await run("bash", ["-c", "( sleep 30 ) & printf out; printf err >&2; sleep 30"], { env: pod.env(), timeoutMs: 100 });

    // Assert: answered with what the command had already said, inside the giving-up window.
    expect(r).toEqual({ code: 1, stdout: "out", stderr: "err" });
    expect(Date.now() - started).toBeLessThan(SIGKILL_AFTER_MS * 2);
  }, 20_000);
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

  it("should replace a percent-encoded value, which is how one of these keys usually carries a token", () => {
    // Act & Assert: stopping at the escape printed the rest of the token.
    expect(redactTokens("access_token=abc12345%2Fdefghijkl")).toBe(`access_token=${REDACTED}`);
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

describe("SIGKILL_AFTER_MS", () => {
  // Asserted from this side because this is the file the cost comes from: `relayDeviceLogin` gives every code
  // two of these beyond its own time, and `jiraExportSignInBudget` is the one caller that has to fit inside a
  // timeout. Dropping the term there would understate the worst case and only show up as a killed command.
  it("should be counted twice per code in the budget atlassian has to fit into", () => {
    // Act & Assert
    expect(jiraExportSignInBudget(1, 0) - jiraExportSignInBudget(0, 0)).toBe(30_000 + 2 * SIGKILL_AFTER_MS);
  });
});

describe("githubSignInGapMs", () => {
  it("should take a whole number of milliseconds in range when one is asked for", () => {
    // Act & Assert
    expect(githubSignInGapMs({ AGENT_HUB_GITHUB_SIGN_IN_GAP_MS: "250" })).toBe(250);
    expect(githubSignInGapMs({ AGENT_HUB_GITHUB_SIGN_IN_GAP_MS: "0" })).toBe(0);
  });

  it("should keep the gap for a value nobody meant to set, which an empty one is", () => {
    // Arrange: `Number("")` is 0, so an unset Helm value or an `env` entry with `value: ""` would otherwise read
    // as a deliberate request for no gap at all — the one setting that brings back what the gap exists to stop.
    // Act & Assert
    expect(githubSignInGapMs({})).toBe(GITHUB_SIGN_IN_GAP_MS);
    expect(githubSignInGapMs({ AGENT_HUB_GITHUB_SIGN_IN_GAP_MS: "" })).toBe(GITHUB_SIGN_IN_GAP_MS);
    expect(githubSignInGapMs({ AGENT_HUB_GITHUB_SIGN_IN_GAP_MS: " " })).toBe(GITHUB_SIGN_IN_GAP_MS);
  });

  it("should keep the gap for anything that is not a millisecond count it can wait", () => {
    // Arrange: `setTimeout` fires after 1ms for anything past a signed 32-bit count, so the far end removes the
    // gap exactly as the empty string does.
    // Act & Assert
    expect(githubSignInGapMs({ AGENT_HUB_GITHUB_SIGN_IN_GAP_MS: "soon" })).toBe(GITHUB_SIGN_IN_GAP_MS);
    expect(githubSignInGapMs({ AGENT_HUB_GITHUB_SIGN_IN_GAP_MS: "-1" })).toBe(GITHUB_SIGN_IN_GAP_MS);
    expect(githubSignInGapMs({ AGENT_HUB_GITHUB_SIGN_IN_GAP_MS: "1.5" })).toBe(GITHUB_SIGN_IN_GAP_MS);
    // `Number` would read these as ten thousand and sixteen; a typo in one must not become a 16ms gap.
    expect(githubSignInGapMs({ AGENT_HUB_GITHUB_SIGN_IN_GAP_MS: "1e4" })).toBe(GITHUB_SIGN_IN_GAP_MS);
    expect(githubSignInGapMs({ AGENT_HUB_GITHUB_SIGN_IN_GAP_MS: "0x10" })).toBe(GITHUB_SIGN_IN_GAP_MS);
    expect(githubSignInGapMs({ AGENT_HUB_GITHUB_SIGN_IN_GAP_MS: String(2 ** 31) })).toBe(GITHUB_SIGN_IN_GAP_MS);
  });
});

describe("outputTail", () => {
  it("should give one line with the escapes gone and the whitespace collapsed", () => {
    // Act & Assert
    expect(outputTail("\x1b[1m! First copy\x1b[22m\n\n  your code\n")).toBe("! First copy your code");
  });

  it("should redact a value the command wrapped or indented away from its key", () => {
    // Arrange: the key-and-value shapes allow one space, and collapsing the whitespace afterwards would have
    // tidied these onto one line with the token still in them.
    const token = `${"Zy3_"}AbCdEfGh12345678`;

    // Act & Assert
    expect(outputTail(`refresh_token:    ${token}`)).toBe(`refresh_token: ${REDACTED}`);
    expect(outputTail(`refresh_token:\n  ${token}`)).toBe(`refresh_token: ${REDACTED}`);
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

  it("should reject rather than hang when building the answer throws", async () => {
    // Arrange: `isExpiry` is the caller's function and runs while the answer is being built, after the promise
    // has been marked settled. A throw from there used to leave it pending for ever — the same hang the kill
    // escalation exists to prevent, reached from the other end — and nothing above it has a timeout.
    const boom = new Error("isExpiry looked at the output and threw");

    // Act
    const error = await relayDeviceLogin({
      api: api(),
      id: VID,
      kind: "azure",
      cmd: "az",
      args: ["login", "--use-device-code"],
      env: pod.env(),
      parse: parseAzDeviceCode,
      isExpiry: () => {
        throw boom;
      },
      label: "github"
    }).catch((e: unknown) => e);

    // Assert
    expect(error).toBe(boom);
  }, 20_000);

  it("should let go of a command that ignores the signal, rather than wait on it for ever", async () => {
    // Arrange: `trap '' TERM` is ignored across `exec`, and the subshell this backgrounds inherits it and
    // outlives every signal sent to its parent, holding the pipes open so that `close` can never arrive. That
    // is the only way to reach the giving-up step, and it prints a device code after it, which nothing should
    // still be listening for. Nothing above this has a timeout of its own.
    pod.shim("stubborn", `trap '' TERM\n( sleep 13; printf '%s' "$2" >&2 ) &\nprintf '%s' "$1" >&2\nsleep 60`);
    // A child's stdio handles and the mock hub's connections are both `Socket`s, and only the second kind has a
    // `remoteAddress`. Counting all of them would measure the hub reaping its own idle keep-alives against this
    // test's fifteen seconds, which is a slack of two in whichever direction the reaping happens to fall — the
    // same two this is here to catch.
    const pipes = () =>
      (process as unknown as { _getActiveHandles: () => { constructor: { name: string }; remoteAddress?: string }[] })
        ._getActiveHandles()
        .filter((h) => h.constructor.name === "Socket" && h.remoteAddress === undefined).length;
    // A tick for any earlier case's destroyed handles to drop out, so the baseline is what is really held and
    // the count either side of the call differs by this child's pipes alone.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const before = pipes();
    const expiresIn = -29;

    // Act: `expiresIn + 30` is the kill timer, so one second in, then SIGKILL and the giving-up step follow it.
    const started = Date.now();
    const error = await relayDeviceLogin({
      api: api(),
      id: VID,
      kind: "azure",
      cmd: "stubborn",
      args: ["waiting for the owner\n", AZ_OUTPUT],
      env: pod.env(),
      parse: parseAzDeviceCode,
      expiresIn,
      label: "azure"
    }).catch((e: unknown) => e);

    // Assert: answered inside the escalation rather than the minute the child asked for.
    expect((error as Error).message).toMatch(/stubborn printed no sign-in code/);
    expect(Date.now() - started).toBeLessThan(SIGKILL_AFTER_MS * 3);

    // Then past the orphan's own print, which is when both of the things it must not do would show. A `destroy`
    // releases its handle on a later tick, so the count is read here rather than the moment the call answered.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    // Its pipes are let go of, not merely stopped being waited on: they are ref'd handles, and `cli.ts` sets
    // `process.exitCode` without calling `process.exit`, so holding them would answer this call and still never
    // let `agent-hub virtual github-login` return. Exactly the two this child opened, so the leak is the margin.
    expect(pipes()).toBe(before);
    // And nothing is left reading it: relaying its code now would put a live one on the owner's screen that
    // this call has already answered `shown: false` for, with no `loginFailed` to withdraw it.
    expect(virtual().prompts).toEqual([]);
  }, 40_000);

  it("should stop the command and reject when the code cannot be relayed to the hub", async () => {
    // Arrange: the hub refuses the relay outright, so the owner would never see the code. A 400 is not a
    // retryable status, so `withRetry` gives up on the first attempt.
    const failing: Pick<Api, "loginPrompt" | "virtualStatus"> = {
      loginPrompt: async () => {
        throw new ApiError(400, { error: "hub down" }, "POST", `/api/virtual/${VID}/login/azure`);
      },
      virtualStatus: async () => null
    };

    // Act
    const { error, stderr } = await captureStderrOfFailure(() =>
      relayDeviceLogin({
        api: failing,
        id: VID,
        kind: "azure",
        cmd: "bash",
        args: ["-c", `printf '%s' ${JSON.stringify(AZ_OUTPUT)}; sleep 30`],
        env: pod.env(),
        parse: parseAzDeviceCode,
        expiresIn: 1,
        label: "azure"
      })
    );

    // Assert
    expect((error as Error).message).toMatch(/^could not relay the azure sign-in code: POST .*400 hub down$/);
    expect(stderr).toBe("");
  });

  function relay(script: string, options: Partial<Parameters<typeof relayDeviceLogin>[0]> = {}): Promise<RelayDeviceLoginResult> {
    return relayDeviceLogin({
      api: api(),
      id: VID,
      kind: "azure",
      cmd: "bash",
      args: ["-c", `printf '%s' ${JSON.stringify(AZ_OUTPUT)}; ${script}`],
      env: pod.env(),
      parse: parseAzDeviceCode,
      label: "azure",
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
  const PENDING = "error=authorization_pending&error_description=The+authorization+request+is+still+pending.";
  const EXPIRED = "error=expired_token&error_description=The+code+expired.";
  const DENIED = "error=access_denied&error_description=The+user+cancelled+it.";
  const token = (value: string) => new URLSearchParams({ access_token: value, token_type: "bearer" }).toString();

  const deviceCode = (extra: Record<string, string> = {}) =>
    new URLSearchParams({
      device_code: "dev-code",
      user_code: "7B7F-C198",
      verification_uri: "https://github.com/login/device",
      expires_in: "899",
      // A second rather than github.com's five, so a poll is two seconds behind the code rather than ten.
      interval: "1",
      ...extra
    }).toString();

  /**
   * github.com, scripted per attempt: each argument is what every poll of that attempt's code answers, the last
   * one standing for any further attempt. A mint is what moves it on, which is what makes a budget readable here.
   */
  function githubAnswering(...attempts: string[]): typeof fetch {
    let attempt = -1;
    return (async (url: string | URL) => {
      const minting = String(url).endsWith("/login/device/code");
      if (minting) {
        attempt += 1;
      }
      const body = minting ? deviceCode() : (attempts[Math.min(attempt, attempts.length - 1)] ?? PENDING);
      return new Response(body, { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    }) as unknown as typeof fetch;
  }

  // Every case here takes the wait between codes as a no-op, as `withRetry`'s own `wait` is taken: a minute of
  // it buys a test nothing. "should wait between codes" is where the waiting itself is asserted.
  const signIn = (fetchImpl: typeof fetch, extra: Record<string, string> = {}, opts: Partial<GithubLoginOptions> = {}) =>
    githubLogin({ api: api(), env: pod.env(extra), fetchImpl, wait: async () => {}, ...opts });

  it("should relay the device code, poll for the token itself and hand it to gh", async () => {
    // Arrange: GH_TOKEN is in the pod's environment and the shim exits 9 if it reaches gh.
    // Act
    const { result, stderr } = await captureStderr(() => signIn(githubAnswering(token(GH_TOKEN)), { GH_TOKEN: "stale" }));

    // Assert
    expect(result).toBe("signed-in");
    expect(virtual().prompts).toEqual([
      { kind: "github", prompt: "device_code", verification_uri: "https://github.com/login/device", user_code: "7B7F-C198", expires_in: 899 }
    ]);
    expect(virtual().completes).toEqual([{ kind: "github", account_label: "octocat" }]);
    expect(fs.readFileSync(path.join(pod.stateDir, "gh-login-args"), "utf8")).toMatch(/--with-token/);
    expect(virtual().credentials.get("github")).toBe(GH_TOKEN);
    expect(stderr).not.toContain(GH_TOKEN);
  });

  it("should say which OAuth app the owner is being asked to authorise", async () => {
    // Act
    const { stderr } = await captureStderr(() => signIn(githubAnswering(token(GH_TOKEN))));

    // Assert: the default is the app every gh binary carries, so without this line the only record of whose app
    // a pod's owner granted is a constant in the source.
    expect(stderr).toMatch(/github: signing in through the GitHub CLI OAuth app \(client 178c6fc778ccc68e1d6a\)/);
  });

  it("should store the token gh already holds without relaying a code when an earlier call signed it in", async () => {
    // Arrange: a pod whose previous call was granted a token and failed only to finish storing it. gh's config
    // is memory-backed, so a token there is one this pod was granted — asking for another would ask the owner
    // to authorise what they have authorised already.
    fs.writeFileSync(path.join(pod.stateDir, "gh-token"), GH_TOKEN);

    // Act
    const { result, stderr } = await captureStderr(() => signIn(githubAnswering(DENIED)));

    // Assert
    expect(result).toBe("signed-in");
    expect(virtual().prompts).toEqual([]);
    expect(virtual().credentials.get("github")).toBe(GH_TOKEN);
    expect(stderr).toMatch(/github: gh is already signed in; storing the token it holds/);
  });

  it("should relay a fresh code on a later call, which is what keeps a dead one off the owner's screen", async () => {
    // Arrange: the budget is per call, and `virtual-agent-boot` calls this again for anything that is not the
    // owner's to act on. Each code replaces the last, so none outlives its own time by long.
    await captureStderr(() => signIn(githubAnswering(DENIED, DENIED, DENIED)));
    virtual().loginFailures.length = 0;

    // Act
    await captureStderr(() => signIn(githubAnswering(token(GH_TOKEN))));

    // Assert
    expect(virtual().prompts.filter((prompt) => prompt.kind === "github")).toHaveLength(GITHUB_SIGN_IN_CODES + 1);
  });

  it("should spend every code and report the sign-in failed when GitHub answers the poll with a refusal", async () => {
    // Arrange: an owner who cancels, or an app registration GitHub will not run the flow for. Each attempt is
    // over in a poll, which is why the budget has a gap in it.
    // Act
    const { result, stderr } = await captureStderr(() => signIn(githubAnswering(DENIED, DENIED, DENIED)));

    // Assert
    expect(result).toBe("not-signed-in");
    expect(virtual().prompts).toHaveLength(GITHUB_SIGN_IN_CODES);
    expect(virtual().loginFailures).toEqual([
      { kind: "github", state: "failed", detail: "github: GitHub stopped the sign-in before it could be completed, so the code is no longer any use" }
    ]);
    // What GitHub answered is the only thing that says why, and the pod's log is where it goes.
    expect(stderr).toMatch(/GitHub answered access_denied: The user cancelled it\./);
  });

  it("should stop at its budget of codes and report the sign-in expired when each one runs out", async () => {
    // Arrange: `expired_token` is GitHub's own word that a code reached its `expires_in` unused, which is what
    // an owner who never came back to it produces.
    // Act
    const { result } = await captureStderr(() => signIn(githubAnswering(EXPIRED, EXPIRED, EXPIRED)));

    // Assert
    expect(result).toBe("not-signed-in");
    expect(virtual().prompts).toHaveLength(GITHUB_SIGN_IN_CODES);
    expect(virtual().loginFailures).toEqual([
      { kind: "github", state: "expired", detail: "github: the sign-in code ran out before it was used; start the agent again to be sent another" }
    ]);
  });

  it("should take the owner's next code when an earlier one was refused and a later one works", async () => {
    // Arrange: the budget is not conditioned on why an attempt failed, because a fault that does not last is
    // exactly what the second chance is for.
    // Act
    const { result } = await captureStderr(() => signIn(githubAnswering(DENIED, token(GH_TOKEN))));

    // Assert
    expect(result).toBe("signed-in");
    expect(virtual().prompts).toHaveLength(2);
    expect(virtual().loginFailures).toEqual([]);
    expect(virtual().credentials.get("github")).toBe(GH_TOKEN);
  });

  it("should keep the owner's code and poll on when GitHub answers a fault, which is what gh will not do", async () => {
    // Arrange: a 429 and then a reset, both of which end the sign-in under `gh auth login --web` and take the
    // owner's code with them.
    let n = 0;
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith("/login/device/code")) {
        return new Response(deviceCode(), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      }
      switch (n++) {
        case 0:
          return new Response("<html>too many requests</html>", { status: 429, headers: { "Retry-After": "0", "Content-Type": "text/html" } });
        case 1:
          throw new Error("socket hang up");
        default:
          return new Response(token(GH_TOKEN), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      }
    }) as unknown as typeof fetch;

    // Act
    const { result, stderr } = await captureStderr(() => signIn(fetchImpl));

    // Assert: one code relayed, never withdrawn, and the sign-in completed on the third poll of it.
    expect(result).toBe("signed-in");
    expect(virtual().prompts).toHaveLength(1);
    expect(virtual().loginFailures).toEqual([]);
    expect(stderr).toMatch(/github: GitHub answered HTTP 429; the code is still good/);
    expect(stderr).toMatch(/github: the poll could not reach GitHub \(socket hang up\); the code is still good/);
  });

  it("should spend only one code on a relay that failed after the hub already had the code", async () => {
    // Arrange: the prompt landed, so a code is on the owner's screen; the status after it did not. A 400 and
    // not a 500, because `withRetry` rides a 500 out and the relay would never fail at all. One code gone, and
    // the next one earned: a single hub blip costs a code rather than the call.
    hub.failNextStatuses(1, 400);

    // Act
    const { result } = await captureStderr(() => signIn(githubAnswering(token(GH_TOKEN))));

    // Assert
    expect(result).toBe("signed-in");
    expect(virtual().prompts).toHaveLength(2);
    expect(virtual().credentials.get("github")).toBe(GH_TOKEN);
  });

  it("should report the sign-in rather than throw when every code reached the owner but no status did", async () => {
    // Arrange: a code on their screen is a code they could have used, whatever failed after it, so the hub is
    // owed a `failed` and the caller must not be asked to relay a fourth. Throwing here is what puts a pod back
    // to handing out a code every few minutes.
    hub.failNextStatuses(GITHUB_SIGN_IN_CODES, 400);

    // Act
    const { result } = await captureStderr(() => signIn(githubAnswering(PENDING)));

    // Assert
    expect(result).toBe("not-signed-in");
    expect(virtual().prompts).toHaveLength(GITHUB_SIGN_IN_CODES);
    expect(virtual().loginFailures).toEqual([
      { kind: "github", state: "failed", detail: "github: the sign-in could not be finished; start the agent again to be sent another code" }
    ]);
  });

  it("should throw rather than report the owner at fault when GitHub will not mint a code for them", async () => {
    // Arrange: nothing ever reached the owner, so there is nothing to conclude about them and nothing for the
    // hub to mark. The boot script rides this out on its own backoff.
    const fetchImpl = (async () =>
      new Response("error=device_flow_disabled&error_description=Not+enabled.", {
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      })) as unknown as typeof fetch;

    // Act
    const { error } = await captureStderrOfFailure(() => signIn(fetchImpl));

    // Assert
    expect((error as Error).message).toMatch(/GitHub would not give a device code: device_flow_disabled/);
    expect(virtual().prompts).toEqual([]);
    expect(virtual().loginFailures).toEqual([]);
  });

  it("should call it expired, not refused, when GitHub says the code ran out", async () => {
    // Arrange: our own deadline is set after the mint and after the relay, both of which can back off, so
    // GitHub's clock always runs out first and its word is what the owner's report has to come from.
    // Act
    await captureStderr(() => signIn(githubAnswering(EXPIRED, EXPIRED, EXPIRED)));

    // Assert
    expect(virtual().loginFailures[0]).toMatchObject({ state: "expired" });
  });

  it("should keep a token the owner granted when gh cannot reach GitHub to validate it", async () => {
    // Arrange: gh exits 1 whether the token is bad or the API is briefly away, so the attempt is repeated.
    // Act
    const { result } = await captureStderr(() => signIn(githubAnswering(token(GH_TOKEN)), { FAKE_GH_STORE_FAILS: "2" }));

    // Assert
    expect(result).toBe("signed-in");
    expect(virtual().credentials.get("github")).toBe(GH_TOKEN);
    expect(virtual().loginFailures).toEqual([]);
  });

  it("should store a token the owner granted before gh is handed it, and report when gh refuses it", async () => {
    // Arrange: a token GitHub will not accept. The grant is still the scarce thing, so it is on the hub before
    // gh is asked — the boot script's watcher reads it and tries it again without costing another code.
    // Act
    const { result, stderr } = await captureStderr(() => signIn(githubAnswering(token(GH_TOKEN)), { FAKE_GH_REFUSES_TOKEN: GH_TOKEN }));

    // Assert
    expect(result).toBe("not-signed-in");
    expect(virtual().credentials.get("github")).toBe(GH_TOKEN);
    expect(virtual().completes).toEqual([]);
    expect(virtual().loginFailures).toEqual([
      {
        kind: "github",
        state: "failed",
        detail: "github: GitHub would not accept the token the sign-in granted; it is stored, so the agent will keep trying it"
      }
    ]);
    // gh's own words say whether a scope was refused or the token was already revoked, redacted on the way out.
    expect(stderr).toMatch(/gh would not store the GitHub token the owner signed in for \(exit 1\): error validating token: HTTP 401: Bad credentials/);
    expect(stderr).not.toContain(GH_TOKEN);
  });

  it("should throw rather than ask for a code when gh refuses a token nobody was asked for", async () => {
    // Arrange: the token came out of gh's own config, so no code was spent and there is nothing to report.
    fs.writeFileSync(path.join(pod.stateDir, "gh-token"), GH_TOKEN);

    // Act
    const { error } = await captureStderrOfFailure(() => signIn(githubAnswering(token(GH_TOKEN)), { FAKE_GH_REFUSES_TOKEN: GH_TOKEN }));

    // Assert
    expect((error as Error).message).toMatch(/gh would not store the GitHub token/);
    expect(virtual().prompts).toEqual([]);
    expect(virtual().loginFailures).toEqual([]);
  });

  it("should throw rather than report a failed sign-in when the hub cannot be given a token GitHub granted", async () => {
    // Arrange: the owner completed the sign-in and the store is what failed, so the sign-in did not fail and
    // they have nothing left to do. Reporting one would withdraw the code they used and ask them to paste the
    // token they have just authorised.
    hub.failNextCredentialPuts(1, 400);

    // Act
    const { error } = await captureStderrOfFailure(() => signIn(githubAnswering(token(GH_TOKEN))));

    // Assert
    expect((error as Error).message).toMatch(/400/);
    expect(virtual().loginFailures).toEqual([]);
    expect(virtual().completes).toEqual([]);
  });

  it("should still report the failure to its caller when the hub will not take the report", async () => {
    // Arrange: a hub with no row for this sign-in refuses the report, which may not become the failure said.
    const refusing: Api = {
      ...api(),
      loginFailed: () => Promise.reject(new ApiError(404, { error: "there is no github sign-in to report on" }, "POST", "login/github/failed"))
    };

    // Act
    const { result, stderr } = await captureStderr(() =>
      githubLogin({ api: refusing, env: pod.env(), fetchImpl: githubAnswering(DENIED, DENIED, DENIED), wait: async () => {} })
    );

    // Assert
    expect(result).toBe("not-signed-in");
    expect(stderr).toMatch(/github: could not tell agent-hub the sign-in was not completed/);
  });

  it("should keep a long fault out of the detail, which the hub rejects over 500 characters", async () => {
    // Arrange: a transport fault whose own message is long — an undici error with its causes reads like this —
    // on a code with a second to live. The hub answers `400` to a detail over 500 characters and a `400` is not
    // retryable, so a fault's message interpolated into one would be a report the owner never gets.
    const long = `connect ECONNREFUSED ${"140.82.121.4:443 ".repeat(60)}`;
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith("/login/device/code")) {
        return new Response(deviceCode({ expires_in: "1" }), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      }
      throw new Error(long);
    }) as unknown as typeof fetch;

    // Act
    const { result, stderr } = await captureStderr(() => githubLogin({ api: api(), env: pod.env(), fetchImpl, codes: 1 }));

    // Assert: the owner is told what to do about it, and the whole of what happened goes to the pod's log.
    expect(result).toBe("not-signed-in");
    expect(virtual().loginFailures).toEqual([
      { kind: "github", state: "failed", detail: "github: the sign-in could not be finished; start the agent again to be sent another code" }
    ]);
    expect(stderr).toContain("connect ECONNREFUSED");
  });

  it("should wait between codes, so a fault that may not last is given the time not to", async () => {
    // Arrange: an attempt refused on its first poll is over in seconds, so without this the budget is three
    // codes in half a minute — the same fault three times rather than three chances at it.
    const waits: number[] = [];

    // Act
    await captureStderr(() =>
      githubLogin({
        api: api(),
        env: pod.env(),
        fetchImpl: githubAnswering(DENIED, DENIED, DENIED),
        wait: async (ms) => {
          waits.push(ms);
        }
      })
    );

    // Assert: one wait between each pair of codes, at the gap the pod uses rather than one a test chose, less
    // whatever the attempt itself took. The short waits in the list are the polls' own.
    const gaps = waits.filter((ms) => ms > GITHUB_SIGN_IN_GAP_MS / 2);
    expect(gaps).toHaveLength(GITHUB_SIGN_IN_CODES - 1);
    for (const ms of gaps) {
      expect(ms).toBeLessThanOrEqual(GITHUB_SIGN_IN_GAP_MS);
    }
  });

  it("should not wait at all when the attempt already took the gap, as one that ran its code out has", async () => {
    // Arrange: a gap this short is the fifteen-minute case in miniature — there is nothing left to wait for,
    // and waiting again would add an hour to three expiring codes.
    const waits: number[] = [];

    // Act
    await captureStderr(() =>
      githubLogin({
        api: api(),
        env: pod.env(),
        fetchImpl: githubAnswering(EXPIRED, EXPIRED, EXPIRED),
        gapMs: 1,
        wait: async (ms) => {
          waits.push(ms);
        }
      })
    );

    // Assert
    expect(waits.filter((ms) => ms === 0)).toEqual([0, 0]);
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
