// The device flow against a scripted GitHub: the answers are the ones github.com was measured giving, and
// what each of them does to the poll is the whole point of running the flow here rather than in gh.
import { describe, expect, it } from "vitest";
import {
  classifyPollAnswer,
  DEFAULT_EXPIRES_IN_S,
  DEFAULT_INTERVAL_S,
  DeviceFlowError,
  deviceCodeUrl,
  deviceFlowRetryable,
  GITHUB_CLIENT_ID,
  GITHUB_SCOPES,
  MAX_TRANSIENT_WAIT_S,
  MIN_INTERVAL_S,
  nextWaitSeconds,
  POLL_INTERVAL_MULTIPLIER,
  POLL_JITTER,
  parseOAuthBody,
  pollDeviceToken,
  positiveInt,
  requestDeviceCode,
  retryAfterSeconds,
  tokenUrl
} from "./github-device-flow.ts";

const HOST = "https://github.test";
const ENV = { GITHUB_OAUTH_HOST: HOST };
const TOKEN = `${"gh"}o_deviceFlowTestToken`;

const PENDING = "error=authorization_pending&error_description=The+authorization+request+is+still+pending.";
const CODE_BODY = "device_code=dev-code&user_code=7B7F-C198&verification_uri=https%3A%2F%2Fgithub.com%2Flogin%2Fdevice&expires_in=899&interval=5";

type Answer = { status?: number; headers?: Record<string, string>; body?: string; throws?: string };

/** A `fetch` that answers the scripted list in order and repeats the last answer after that. */
function fakeFetch(answers: Answer[]): { fetchImpl: typeof fetch; bodies: string[]; urls: string[] } {
  const bodies: string[] = [];
  const urls: string[] = [];
  let n = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    urls.push(String(url));
    bodies.push(String(init?.body ?? ""));
    const answer = answers[Math.min(n++, answers.length - 1)] ?? {};
    if (answer.throws !== undefined) {
      throw new Error(answer.throws);
    }
    return new Response(answer.body ?? "", {
      status: answer.status ?? 200,
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...answer.headers }
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies, urls };
}

/** A clock the waits drive, so a 15-minute poll is a synchronous list of waits. */
function clock() {
  let nowMs = 1_000_000;
  const waits: number[] = [];
  return {
    now: () => nowMs,
    wait: async (ms: number) => {
      waits.push(ms);
      nowMs += ms;
    },
    waits
  };
}

const half = () => 0.5;
const form = (values: Record<string, string>) => new URLSearchParams(values).toString();

describe("parseOAuthBody", () => {
  it("should read the form-encoded body github.com answers a client that does not ask for JSON", () => {
    // Act & Assert
    expect(parseOAuthBody(PENDING)).toEqual({
      error: "authorization_pending",
      error_description: "The authorization request is still pending."
    });
  });

  it("should read a JSON body and stringify its numbers when the body is JSON", () => {
    // Act & Assert
    expect(parseOAuthBody('{"error":"slow_down","interval":15,"ok":true}')).toEqual({ error: "slow_down", interval: "15" });
  });

  it("should find neither a token nor an error when the answer is a page GitHub did not write", () => {
    // Act
    const values = parseOAuthBody("<!DOCTYPE html>\n<html><body>Too many requests</body></html>");

    // Assert: the status is then what classifies it, which is the right answer for a proxy's page.
    expect(values.error).toBeUndefined();
    expect(values.access_token).toBeUndefined();
  });

  it("should be empty when a body that opens like JSON is not JSON", () => {
    // Act & Assert
    expect(parseOAuthBody("{not json")).toEqual({});
  });
});

describe("positiveInt", () => {
  it("should read a positive integer and refuse everything else", () => {
    // Act & Assert
    expect(positiveInt("15")).toBe(15);
    expect(positiveInt(" 15 ")).toBe(15);
    expect(positiveInt("0")).toBeNull();
    expect(positiveInt("-5")).toBeNull();
    expect(positiveInt("soon")).toBeNull();
    expect(positiveInt(undefined)).toBeNull();
  });
});

describe("retryAfterSeconds", () => {
  it("should read the delta-seconds form and leave an HTTP-date to the default", () => {
    // Act & Assert
    expect(retryAfterSeconds("30")).toBe(30);
    expect(retryAfterSeconds(null)).toBeNull();
    expect(retryAfterSeconds("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
  });
});

describe("classifyPollAnswer", () => {
  it("should be the token when the owner has completed the sign-in", () => {
    // Act & Assert
    expect(classifyPollAnswer(200, null, { access_token: TOKEN })).toEqual({ outcome: "token", token: TOKEN });
  });

  it("should be pending while the owner has not entered the code", () => {
    // Act & Assert
    expect(classifyPollAnswer(200, null, parseOAuthBody(PENDING))).toEqual({ outcome: "pending" });
  });

  it("should carry the server's new minimum when it answers slow_down with one", () => {
    // Act & Assert
    expect(classifyPollAnswer(200, null, { error: "slow_down", interval: "15" })).toEqual({ outcome: "slow-down", interval: 15 });
    expect(classifyPollAnswer(200, null, { error: "slow_down" })).toEqual({ outcome: "slow-down", interval: null });
  });

  it("should end the sign-in and name the error when the owner cancelled it", () => {
    // Act
    const answer = classifyPollAnswer(200, null, { error: "access_denied", error_description: "The user cancelled it." });

    // Assert
    expect(answer).toEqual({ outcome: "fatal", error: "access_denied", detail: "GitHub answered access_denied: The user cancelled it." });
  });

  it("should end the sign-in on an error outside the set, because the code is spent either way", () => {
    // Act & Assert
    expect(classifyPollAnswer(200, null, { error: "something_new" })).toMatchObject({ outcome: "fatal", error: "something_new" });
  });

  it("should end the sign-in when a 200 carries neither a token nor an error", () => {
    // Act & Assert
    expect(classifyPollAnswer(200, null, {})).toMatchObject({ outcome: "fatal", error: "" });
  });

  it("should wait and keep the code when GitHub answers 429, honouring Retry-After", () => {
    // Act & Assert: this is the answer gh ends the sign-in on.
    expect(classifyPollAnswer(429, 42, {})).toEqual({ outcome: "retry", seconds: 42, detail: "GitHub answered HTTP 429" });
  });

  it("should wait and keep the code when GitHub answers a server fault", () => {
    // Act & Assert
    expect(classifyPollAnswer(503, null, {})).toEqual({ outcome: "retry", seconds: null, detail: "GitHub answered HTTP 503" });
  });
});

describe("nextWaitSeconds", () => {
  it("should wait a multiple of the server's minimum, so a poll never lands early", () => {
    // Act & Assert
    expect(nextWaitSeconds(DEFAULT_INTERVAL_S, half)).toBe(DEFAULT_INTERVAL_S * POLL_INTERVAL_MULTIPLIER);
  });

  it("should jitter within the band, so pods that booted together stop asking together", () => {
    // Act
    const low = nextWaitSeconds(5, () => 0);
    const high = nextWaitSeconds(5, () => 1);

    // Assert
    expect(low).toBeCloseTo(10 * (1 - POLL_JITTER));
    expect(high).toBeCloseTo(10 * (1 + POLL_JITTER));
  });

  it("should floor a host that says interval=0, so it cannot become a tight loop", () => {
    // Act & Assert
    expect(nextWaitSeconds(0, half)).toBe(MIN_INTERVAL_S * POLL_INTERVAL_MULTIPLIER);
  });
});

describe("requestDeviceCode", () => {
  it("should mint a code for gh's app and this pod's scopes", async () => {
    // Arrange
    const { fetchImpl, bodies, urls } = fakeFetch([{ body: CODE_BODY }]);

    // Act
    const code = await requestDeviceCode({ env: ENV, fetchImpl });

    // Assert
    expect(code).toEqual({
      device_code: "dev-code",
      user_code: "7B7F-C198",
      verification_uri: "https://github.com/login/device",
      expires_in: 899,
      interval: 5
    });
    expect(urls).toEqual([deviceCodeUrl(HOST)]);
    expect(new URLSearchParams(bodies[0] as string).get("client_id")).toBe(GITHUB_CLIENT_ID);
    expect(new URLSearchParams(bodies[0] as string).get("scope")).toBe(GITHUB_SCOPES);
  });

  it("should fall back to github.com's own figures when the answer leaves them out", async () => {
    // Arrange
    const { fetchImpl } = fakeFetch([{ body: form({ device_code: "dev-code", user_code: "AAAA-BBBB", verification_uri: "https://github.com/login/device" }) }]);

    // Act
    const code = await requestDeviceCode({ env: ENV, fetchImpl });

    // Assert
    expect(code.expires_in).toBe(DEFAULT_EXPIRES_IN_S);
    expect(code.interval).toBe(DEFAULT_INTERVAL_S);
  });

  it("should be worth another attempt when GitHub could not be reached", async () => {
    // Arrange
    const { fetchImpl } = fakeFetch([{ throws: "ECONNRESET" }]);

    // Act
    const error = await requestDeviceCode({ env: ENV, fetchImpl }).catch((e: unknown) => e);

    // Assert
    expect(error).toBeInstanceOf(DeviceFlowError);
    expect(deviceFlowRetryable(error)).toBe(true);
    expect((error as Error).message).toMatch(/could not reach GitHub for a device code \(ECONNRESET\)/);
  });

  it("should not be worth another attempt when the app has the device flow turned off", async () => {
    // Arrange
    const { fetchImpl } = fakeFetch([{ status: 400, body: form({ error: "device_flow_disabled", error_description: "Not enabled." }) }]);

    // Act
    const error = await requestDeviceCode({ env: ENV, fetchImpl }).catch((e: unknown) => e);

    // Assert
    expect(deviceFlowRetryable(error)).toBe(false);
    expect((error as DeviceFlowError).error).toBe("device_flow_disabled");
  });

  it("should be worth another attempt when the answer is a status and nothing GitHub wrote", async () => {
    // Arrange
    const { fetchImpl } = fakeFetch([{ status: 502, body: "<html>bad gateway</html>" }]);

    // Act
    const error = await requestDeviceCode({ env: ENV, fetchImpl }).catch((e: unknown) => e);

    // Assert
    expect(deviceFlowRetryable(error)).toBe(true);
    expect((error as Error).message).toMatch(/HTTP 502/);
  });

  it("should refuse a code whose page is not an https URL, because a person is sent to it", async () => {
    // Arrange
    const { fetchImpl } = fakeFetch([{ body: form({ device_code: "d", user_code: "u", verification_uri: "http://github.com/login/device" }) }]);

    // Act
    const error = await requestDeviceCode({ env: ENV, fetchImpl }).catch((e: unknown) => e);

    // Assert
    expect((error as Error).message).toMatch(/without a code and an https page/);
  });
});

describe("pollDeviceToken", () => {
  const code = { device_code: "dev-code", user_code: "7B7F-C198", verification_uri: "https://github.com/login/device", expires_in: 899, interval: 5 };

  it("should hand back the token and ask with the grant type the device flow takes", async () => {
    // Arrange
    const { fetchImpl, bodies, urls } = fakeFetch([{ body: form({ access_token: TOKEN }) }]);
    const t = clock();

    // Act
    const result = await pollDeviceToken({ code, env: ENV, fetchImpl, wait: t.wait, now: t.now, random: half });

    // Assert
    expect(result).toEqual({ outcome: "token", token: TOKEN });
    expect(urls).toEqual([tokenUrl(HOST)]);
    expect(new URLSearchParams(bodies[0] as string).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(t.waits).toEqual([10000]);
  });

  it("should keep polling while the owner has not entered the code", async () => {
    // Arrange
    const { fetchImpl } = fakeFetch([{ body: PENDING }, { body: PENDING }, { body: form({ access_token: TOKEN }) }]);
    const t = clock();

    // Act
    const result = await pollDeviceToken({ code, env: ENV, fetchImpl, wait: t.wait, now: t.now, random: half });

    // Assert
    expect(result).toEqual({ outcome: "token", token: TOKEN });
    expect(t.waits).toEqual([10000, 10000, 10000]);
  });

  it("should keep the owner's code and wait when GitHub answers 429, waiting out Retry-After", async () => {
    // Arrange: gh ends the sign-in here and the owner's code dies with it.
    const { fetchImpl } = fakeFetch([{ status: 429, headers: { "Retry-After": "60" }, body: "" }, { body: form({ access_token: TOKEN }) }]);
    const t = clock();
    const said: string[] = [];

    // Act
    const result = await pollDeviceToken({ code, env: ENV, fetchImpl, wait: t.wait, now: t.now, random: half, onWait: (d) => said.push(d) });

    // Assert
    expect(result).toEqual({ outcome: "token", token: TOKEN });
    expect(t.waits).toEqual([10000, 60000]);
    expect(said).toEqual(["GitHub answered HTTP 429; the code is still good, so this waits 60s and asks again"]);
  });

  it("should never wait longer than the cap for a Retry-After it is given", async () => {
    // Arrange
    const { fetchImpl } = fakeFetch([{ status: 429, headers: { "Retry-After": "86400" }, body: "" }, { body: form({ access_token: TOKEN }) }]);
    const t = clock();

    // Act
    await pollDeviceToken({ code, env: ENV, fetchImpl, wait: t.wait, now: t.now, random: half });

    // Assert
    expect(t.waits).toEqual([10000, MAX_TRANSIENT_WAIT_S * 1000]);
  });

  it("should keep the owner's code and wait when the poll cannot reach GitHub at all", async () => {
    // Arrange: a reset, a TLS fault or a timeout. gh returns this to its caller and exits 1.
    const { fetchImpl } = fakeFetch([{ throws: "socket hang up" }, { body: form({ access_token: TOKEN }) }]);
    const t = clock();
    const said: string[] = [];

    // Act
    const result = await pollDeviceToken({ code, env: ENV, fetchImpl, wait: t.wait, now: t.now, random: half, onWait: (d) => said.push(d) });

    // Assert
    expect(result).toEqual({ outcome: "token", token: TOKEN });
    expect(t.waits).toEqual([10000, 15000]);
    expect(said[0]).toMatch(/the poll could not reach GitHub \(socket hang up\); the code is still good/);
  });

  it("should go on honouring a growing slow_down past the two gh gives up after", async () => {
    // Arrange: github.com keeps slow_down's count on the device code, cumulatively and for good, so the
    // interval it hands back climbs. gh calls the second one clock drift and ends the sign-in.
    const { fetchImpl } = fakeFetch([
      { body: form({ error: "slow_down", interval: "10" }) },
      { body: form({ error: "slow_down", interval: "15" }) },
      { body: form({ error: "slow_down", interval: "20" }) },
      { body: form({ access_token: TOKEN }) }
    ]);
    const t = clock();

    // Act
    const result = await pollDeviceToken({ code, env: ENV, fetchImpl, wait: t.wait, now: t.now, random: half });

    // Assert
    expect(result).toEqual({ outcome: "token", token: TOKEN });
    expect(t.waits).toEqual([10000, 20000, 30000, 40000]);
  });

  it("should add the RFC's five seconds when slow_down does not say a new interval", async () => {
    // Arrange
    const { fetchImpl } = fakeFetch([{ body: form({ error: "slow_down" }) }, { body: form({ access_token: TOKEN }) }]);
    const t = clock();

    // Act
    await pollDeviceToken({ code, env: ENV, fetchImpl, wait: t.wait, now: t.now, random: half });

    // Assert
    expect(t.waits).toEqual([10000, 20000]);
  });

  it("should end the sign-in and name the error when GitHub refuses it", async () => {
    // Arrange
    const { fetchImpl } = fakeFetch([{ body: form({ error: "access_denied", error_description: "The user cancelled it." }) }]);
    const t = clock();

    // Act
    const result = await pollDeviceToken({ code, env: ENV, fetchImpl, wait: t.wait, now: t.now, random: half });

    // Assert
    expect(result).toEqual({ outcome: "refused", error: "access_denied", detail: "GitHub answered access_denied: The user cancelled it." });
  });

  it("should call the code expired when it ran out with nobody using it", async () => {
    // Arrange: a code nobody enters, polled until its own time is up.
    const { fetchImpl, urls } = fakeFetch([{ body: PENDING }]);
    const t = clock();

    // Act
    const result = await pollDeviceToken({ code, env: ENV, fetchImpl, wait: t.wait, now: t.now, random: half });

    // Assert
    expect(result).toEqual({ outcome: "expired" });
    // 899s at one poll per 10s, with the last wait cut short so the final poll lands on the deadline.
    expect(urls).toHaveLength(90);
    expect(t.waits.at(-1)).toBe(9000);
  });

  it("should not poll once the code has run out, so a fault cannot spend it twice", async () => {
    // Arrange
    const { fetchImpl, urls } = fakeFetch([{ body: PENDING }]);
    const t = clock();

    // Act
    const result = await pollDeviceToken({ code: { ...code, expires_in: 0 }, env: ENV, fetchImpl, wait: t.wait, now: t.now, random: half });

    // Assert
    expect(result).toEqual({ outcome: "expired" });
    expect(urls).toEqual([]);
  });
});
