// Relaying a sign-in a pod cannot do for itself. There is no browser and nobody at the keyboard, so the command's
// device code is read off its own output and relayed to the agent's owner through the hub, and the command left
// running until the owner completes it.
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import type { Api } from "../api.ts";
import type { Env } from "../env.ts";
import { withRetry } from "../retry.ts";
import { say } from "./phases.ts";
import { outputTail, SIGKILL_AFTER_MS } from "./process.ts";

export const DEVICE_CODE_EXPIRES_S = 900;

export type DeviceCodePrompt = {
  verification_uri: string;
  user_code: string;
};

/** Answers a command's prompts: it sees all of the output so far on every chunk. */
export type Respond = (output: string, stdin: Writable | null) => void;

export type RelayDeviceLoginOptions = {
  api: Pick<Api, "loginPrompt" | "virtualStatus">;
  id: string;
  kind: "azure" | "github" | "atlassian";
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  parse: (output: string) => DeviceCodePrompt | null;
  respond?: Respond;
  expiresIn?: number;
  /**
   * Whether the command's own output says it gave up waiting, for a command that says so in words. Read first,
   * because it is the command's own answer rather than an inference about it; the clock is the fallback.
   */
  isExpiry?: (output: string) => boolean;
  label: string;
};

/**
 * How much of `expiresIn` may be left on our clock and the code still count as expired. `relayedAt` is when the code
 * was parsed off the command's output, which is strictly after the command started its own timer, so our elapsed is
 * always short of its. A pty flush or a busy pod widens the gap; a command that gave up seconds early did so
 * because the code ran out, not because the sign-in broke.
 */
export const EXPIRY_TOLERANCE_S = 15;

export type RelayDeviceLoginResult = {
  code: number;
  output: string;
  /**
   * Whether the code was on the owner's screen until it ran out, rather than the sign-in breaking under them: the
   * two are the same exit code, and only one of them is worth offering the owner another code for.
   */
  expired: boolean;
};

export type LoginOptions = {
  api?: Api;
  env?: Env;
};

/**
 * A device-code sign-in that could not be run to an answer. `shown` is whether the hub was given the code
 * before it failed, so the owner may be looking at one: that decides both whether the hub is owed a `failed`
 * for it and whether the failure counts as the owner having been asked.
 */
export class DeviceLoginError extends Error {
  readonly shown: boolean;

  constructor(message: string, shown: boolean) {
    super(message);
    this.name = "DeviceLoginError";
    this.shown = shown;
  }
}

/**
 * Runs a device-code sign-in, relays its code to the owner through the hub as soon as it is printed, and
 * waits for the command to finish (the owner signing in is what finishes it). With `respond`, the command's
 * stdin is a pipe and `respond(output, stdin)` sees all output so far on every chunk, to answer its prompts.
 *
 * Rejects with a `DeviceLoginError` when there is no answer to give back.
 */
export function relayDeviceLogin({
  api,
  id,
  kind,
  cmd,
  args,
  env,
  parse,
  respond,
  expiresIn = DEVICE_CODE_EXPIRES_S,
  isExpiry,
  label
}: RelayDeviceLoginOptions): Promise<RelayDeviceLoginResult> {
  return new Promise((resolve, reject) => {
    let output = "";
    let relayed: Promise<void> | null = null;
    let failed: Error | null = null;
    let relayedAt = 0;
    // Whether the code reached the hub, which is where the owner reads it. Set between the two calls below
    // because only the first of them puts it on their screen, and a relay that fails after it still showed them
    // a code the hub has to be told about.
    let shown = false;
    const child = spawn(cmd, args, { env, stdio: [respond ? "pipe" : "ignore", "pipe", "pipe"] });
    child.stdin?.on("error", () => {});
    // Declared before `settle` closes over them rather than after, so that a synchronous caller added later is
    // an undefined timer to clear and not a temporal dead zone to throw out of the promise.
    let timer: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | null = null;
    let abandon: NodeJS.Timeout | null = null;
    let settled = false;
    // Every end of this promise goes through here, so that the last resort below cannot settle it twice.
    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (escalation) {
        clearTimeout(escalation);
      }
      if (abandon) {
        clearTimeout(abandon);
      }
      // Settling is the one thing that has to happen. `fn` builds the answer, which reads the command's output
      // and calls `isExpiry` — the caller's function, not this one's — and a throw from it would otherwise leave
      // the promise pending for ever with `settled` already true: the hang the teardown above exists to prevent,
      // reached from the other end.
      try {
        fn();
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    // `finish` is async, so both places that call it mark its promise discarded rather than leaving it floating:
    // an unhandled rejection inside a timer callback takes the process down, and this is the teardown whose
    // whole purpose is to stop the process hanging. Discarding it is safe because it cannot reject — the only
    // thing it awaits is `relayed`, a `then(ok, err)` chain that handles both of its own arms, and the `settle`
    // above turns a throw from building the answer into a rejection of this promise instead.
    // SIGTERM asks, SIGKILL insists, and the third step is to stop waiting. A child can ignore the first —
    // `trap '' TERM` survives `exec` — and surviving the second is impossible, so a `close` that still has not
    // come means a descendant it forked holds these pipes. Nothing above this has a timeout of its own, so
    // without the last step the pod sits in `awaiting_login` for as long as it runs.
    //
    // Which is also why the pipes are destroyed rather than only abandoned. The very condition that gets this
    // far — somebody else holding the write ends — is two ref'd Sockets pinning the event loop open, and
    // `cli.ts` sets `process.exitCode` without calling `process.exit`, so settling the promise would leave the
    // command running for ever and the boot script's loop no further on. Destroying them also takes `onData`
    // out of the orphan's way: it would otherwise go on appending its output, and relay a code off it long
    // after this call had answered.
    const endChild = () => {
      child.kill("SIGTERM");
      escalation ??= setTimeout(() => {
        child.kill("SIGKILL");
        abandon ??= setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          void finish(null);
        }, SIGKILL_AFTER_MS);
      }, SIGKILL_AFTER_MS);
    };
    timer = setTimeout(endChild, (expiresIn + 30) * 1000);
    const onData = (d: unknown) => {
      output += d;
      respond?.(output, child.stdin);
      if (relayed) {
        return;
      }
      const prompt = parse(output);
      if (!prompt) {
        return;
      }
      relayedAt = Date.now();
      relayed = withRetry(async () => {
        await api.loginPrompt(id, kind, { prompt: "device_code", ...prompt, expires_in: expiresIn });
        shown = true;
        await api.virtualStatus(id, "awaiting_login", `${label}: the owner must enter code ${prompt.user_code} at ${prompt.verification_uri}`);
      }).then(
        () => say(`${label}: sign-in code relayed to the owner through agent-hub`),
        (e) => {
          failed = e as Error;
          endChild();
        }
      );
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // `null` is the command having been given up on rather than seen to exit, which `run` also reports as 1.
    const finish = async (code: number | null) => {
      await relayed;
      const relayError: Error | null = failed;
      settle(() => {
        // The command's own exit is read before the relay's, because a sign-in it completed is completed whatever
        // the relay did: the token is in its config by now. Rejecting here would throw that away and leave the
        // owner told they had not signed in, where `loginComplete` puts the hub's record right by itself.
        if (relayError && code !== 0) {
          reject(new DeviceLoginError(`could not relay the ${label} sign-in code: ${relayError.message}`, shown));
          return;
        }
        if (relayError) {
          say(`${label}: the sign-in completed although its code could not be relayed (${relayError.message})`);
        }
        if (!relayed) {
          // Quoting output is safe here: a command that printed no code never reached a signed-in state, so it
          // has no token to have printed, and `outputTail` redacts every credential shape regardless.
          reject(new DeviceLoginError(`${cmd} printed no sign-in code (exit ${code}): ${outputTail(output)}`, false));
          return;
        }
        const ranOut = Date.now() - relayedAt >= Math.max(0, expiresIn - EXPIRY_TOLERANCE_S) * 1000;
        resolve({ code: code ?? 1, output, expired: isExpiry?.(output) === true || ranOut });
      });
    };
    child.on("error", (e) => {
      settle(() => reject(new DeviceLoginError(`${cmd} could not start: ${e.message}`, shown)));
    });
    child.on("close", (code) => {
      void finish(code);
    });
  });
}
