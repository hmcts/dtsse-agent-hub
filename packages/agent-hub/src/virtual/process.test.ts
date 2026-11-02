import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMockHub, type MockHub } from "../__fixtures__/mock-hub.ts";
import { createPodShims, type PodShims, podSecrets, usePodEnv } from "../__fixtures__/pod-shims.ts";
import { jiraExportSignInBudget } from "./atlassian.ts";
import { OUTPUT_TAIL_CHARS, outputTail, REDACTED, redactTokens, run, SIGKILL_AFTER_MS, stripAnsi } from "./process.ts";

const VID = "va-sign-in";
const OWNER = { oid: "oid-owner", name: "Olive Owner", email: "olive@example.com" };
const LAUNCH = podSecrets.launchToken;
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
  v.signInRequests.clear();
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
