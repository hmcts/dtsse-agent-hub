// Relaying a device-code sign-in to the owner, against the mock hub with fake commands on PATH that print what the
// real ones print. No real sign-in is ever started, and every assertion that a secret stays off stderr is kept from
// the workspace suite.
import { describe, expect, it } from "vitest";
import { AZ_OUTPUT, captureStderrOfFailure } from "../__fixtures__/pod-shims.ts";
import { useSignInHub, SIGN_IN_VID as VID } from "../__fixtures__/sign-in-hub.ts";
import { type Api, ApiError } from "../api.ts";
import { parseAzDeviceCode } from "./azure-login.ts";
import { EXPIRY_TOLERANCE_S, type RelayDeviceLoginResult, relayDeviceLogin } from "./device-relay.ts";
import { SIGKILL_AFTER_MS } from "./process.ts";

const { pod, virtual, api } = await useSignInHub();

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
