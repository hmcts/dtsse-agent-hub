// The twg (Jira, Confluence) sign-in a pod keeps on the hub, against a fake twg that rotates both tokens on
// every refresh and accepts only the newest refresh token — which is what makes storing the rotated one
// before anything else can fail the thing worth testing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMockHub, type MockHub } from "../__fixtures__/mock-hub.ts";
import {
  captureStderr,
  captureStderrOfFailure,
  createPodShims,
  type PodShims,
  podSecrets,
  TWG_CODE,
  TWG_LOGIN_DENIED_OUTPUT,
  TWG_LOGIN_OUTPUT,
  TWG_LOGIN_TIMEOUT_OUTPUT,
  TWG_URL,
  TWG_WAIT_OUTPUT,
  twgAuthConf,
  twgProfiles,
  usePodEnv
} from "../__fixtures__/pod-shims.ts";
import { type Api, ApiError, type Artefact, type CredentialKind, createApi, type JiraExportReport, type LoginPromptBody } from "../api.ts";
import { JIRA_EXPORT_BASH_TIMEOUT_MS } from "../envelope.ts";
import { runJiraExport } from "../jira-export.ts";
import {
  ATLASSIAN_SIGN_IN_CODES,
  atlassianLogin,
  jiraExportSignInBudget,
  packAtlassianAuth,
  parseTwgDeviceCode,
  readAtlassianAuth,
  restoreAtlassianAuth,
  syncAtlassianAuth,
  TWG_DEVICE_CODE_EXPIRES_S,
  twgDir,
  twgLoginExpired,
  twgPromptsForBrowser,
  twgRefreshRejected
} from "./atlassian.ts";
import { run } from "./sign-in.ts";

const VID = "va-atlassian";
const OWNER = { oid: "oid-owner", name: "Olive Owner", email: "olive@example.com" };
const LAUNCH = podSecrets.launchToken;
const TWG_ACCESS = podSecrets.twgAccess;
const TWG_REFRESH = podSecrets.twgRefresh;

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
  pod.reset();
});

afterAll(async () => {
  await hub.close();
  restoreEnv();
  pod.cleanup();
});

const virtual = () => hub.virtuals.get(VID) as NonNullable<ReturnType<MockHub["virtuals"]["get"]>>;
const api = () => createApi({ baseUrl: url, launchToken: LAUNCH });
const twgLog = () => fs.readFileSync(path.join(pod.stateDir, "twg.log"), "utf8");
const storedAtlassian = () => virtual().credentials.get("atlassian") as string;
const noTwgSecret = (text: string) => !text.includes(TWG_REFRESH) && !text.includes(TWG_ACCESS.slice(0, 40)) && !text.includes(LAUNCH);
const rotatedTo = (n: number) => new RegExp(`^oauth-refresh-token=${TWG_REFRESH}-${n}$`, "m");
const v139 = (extra: Record<string, string> = {}) => pod.env({ FAKE_TWG_VERSION: "1.3.9", ...extra });
type StoredProfiles = { profiles: { createdAt?: string; credentials: { primary: { oauthAccessToken: string; oauthRefreshToken: string } } }[] };
const storedProfile = () => (JSON.parse(storedAtlassian()) as StoredProfiles).profiles[0];

describe("parseTwgDeviceCode", () => {
  it("should read the code through the colour codes and box drawing twg prints it inside", () => {
    // Act & Assert
    expect(parseTwgDeviceCode(TWG_LOGIN_OUTPUT)).toEqual({ verification_uri: TWG_URL, user_code: TWG_CODE });
  });

  it("should be null when only half the code has arrived", () => {
    // Arrange
    const cut = TWG_LOGIN_OUTPUT.indexOf(TWG_CODE.at(-1) as string);

    // Act & Assert
    expect(parseTwgDeviceCode(TWG_LOGIN_OUTPUT.slice(0, cut))).toBeNull();
  });

  it("should build the verification URL from the bare activate link and the Code: line", () => {
    // Act & Assert
    expect(parseTwgDeviceCode("Visit: https://auth.atlassian.com/oauth/activate\r\n  Code:  \x1b[1mQ7RT-9ZXW\x1b[22m\r\n")).toEqual({
      verification_uri: "https://auth.atlassian.com/oauth/activate?user_code=Q7RT-9ZXW",
      user_code: "Q7RT-9ZXW"
    });
  });

  it("should be null when the prompt is all that has been printed", () => {
    // Act & Assert
    expect(parseTwgDeviceCode("Open in browser?")).toBeNull();
  });
});

describe("twgPromptsForBrowser", () => {
  it("should be true once the browser question is on screen and false before it", () => {
    // Act & Assert
    expect(twgPromptsForBrowser(TWG_LOGIN_OUTPUT)).toBe(true);
    expect(twgPromptsForBrowser(TWG_LOGIN_OUTPUT.slice(0, TWG_LOGIN_OUTPUT.indexOf("Open in")))).toBe(false);
  });
});

describe("twgLoginExpired", () => {
  it("should be true for the timeout twg reports when nobody uses the code", () => {
    // Act & Assert
    expect(twgLoginExpired(TWG_LOGIN_TIMEOUT_OUTPUT)).toBe(true);
  });

  it("should be true for a device code Atlassian retired before twg's own timer", () => {
    // Act & Assert
    expect(twgLoginExpired("  ✖  OAuth authentication failed: The device code has expired. Please try again.\n  Code:  [expired_token]\n")).toBe(true);
  });

  it.each([
    ["the owner refusing it", TWG_LOGIN_DENIED_OUTPUT],
    ["a code still being waited on", TWG_WAIT_OUTPUT],
    ["twg falling over", "twg: internal error\n"],
    ["nothing at all", ""]
  ])("should be false for %s, so the owner is not offered another code for it", (_what, output) => {
    // Act & Assert
    expect(twgLoginExpired(output)).toBe(false);
  });
});

describe("packAtlassianAuth", () => {
  it("should drop the access token and keep the rest, trimmed, when given an auth.conf", () => {
    // Act
    const { value, user } = packAtlassianAuth(twgAuthConf());

    // Assert
    expect(value).not.toContain("oauth-access-token");
    expect(value).not.toContain(TWG_ACCESS.slice(0, 40));
    expect(value).toMatch(new RegExp(`^oauth-refresh-token=${TWG_REFRESH}$`, "m"));
    expect(value).toMatch(/^# TWG CLI credentials/);
    expect(value).toBe(value.trim());
    expect(user).toBe("olive@hmcts.net");
  });

  it("should give the same sha for a new access token and a different one for a rotated refresh token", () => {
    // Arrange
    const { sha } = packAtlassianAuth(twgAuthConf());

    // Act & Assert
    expect(packAtlassianAuth(twgAuthConf({ access: "another" })).sha).toBe(sha);
    expect(packAtlassianAuth(twgAuthConf({ refresh: `${TWG_REFRESH}-rotated` })).sha).not.toBe(sha);
  });

  it("should refuse an auth.conf with no refresh token, and one too large for the hub", () => {
    // Act & Assert
    expect(() => packAtlassianAuth(twgAuthConf({ refresh: "" }))).toThrow(/no oauth-refresh-token/);
    expect(() => packAtlassianAuth(twgAuthConf({ user: "x".repeat(24000) }))).toThrow(/over the hub's 24000/);
  });

  it("should have no user when auth.conf names none", () => {
    // Act & Assert
    expect(packAtlassianAuth(`oauth-refresh-token=${TWG_REFRESH}\n`).user).toBeNull();
  });

  it("should blank the access token and keep every other field when given an auth-profiles.json", () => {
    // Act
    const { value, user } = packAtlassianAuth(twgProfiles());

    // Assert
    const profile = (JSON.parse(value) as StoredProfiles).profiles[0];
    expect(profile?.credentials.primary.oauthAccessToken).toBe("");
    expect(profile?.credentials.primary.oauthRefreshToken).toBe(TWG_REFRESH);
    expect(profile?.createdAt).toBeDefined();
    expect(value).not.toContain(TWG_ACCESS.slice(0, 40));
    expect(user).toBe("olive@hmcts.net");
  });

  it("should give the same sha for a new access token and a different one for a rotated refresh token when given an auth-profiles.json", () => {
    // Arrange
    const { sha } = packAtlassianAuth(twgProfiles());

    // Act & Assert
    expect(packAtlassianAuth(twgProfiles({ access: "another" })).sha).toBe(sha);
    expect(packAtlassianAuth(twgProfiles({ refresh: `${TWG_REFRESH}-rotated` })).sha).not.toBe(sha);
  });

  it("should label it with the active environment's default profile when there are several", () => {
    // Arrange
    const parsed = JSON.parse(twgProfiles()) as { defaults: Record<string, string>; profiles: { id: string; user: string }[] };
    const other = JSON.parse(twgProfiles({ user: "someone.else@example.com" })).profiles[0];
    parsed.profiles.unshift({ ...other, id: "other" });

    // Act & Assert
    expect(packAtlassianAuth(JSON.stringify(parsed)).user).toBe("olive@hmcts.net");
    parsed.defaults.prod = "other";
    expect(packAtlassianAuth(JSON.stringify(parsed)).user).toBe("someone.else@example.com");
  });

  it("should refuse an auth-profiles.json with no refresh token, one that is not JSON, and one too large for the hub", () => {
    // Act & Assert
    expect(() => packAtlassianAuth(twgProfiles({ refresh: "" }))).toThrow(/no oauthRefreshToken/);
    expect(() => packAtlassianAuth("{ not json")).toThrow(/not JSON/);
    expect(() => packAtlassianAuth(twgProfiles({ user: "x".repeat(12000) }))).toThrow(/auth-profiles.json without its access tokens .* over the hub's 24000/);
  });
});

describe("twgRefreshRejected", () => {
  it.each([
    ["twg 1.3.3's exit 77", { code: 77, stdout: "" }],
    [
      "twg 1.3.9's unauthorized_client",
      { code: 1, stdout: JSON.stringify({ data: { status: "error", profiles: [{ status: "error", errorCode: "unauthorized_client" }] } }) }
    ],
    ["an invalid_grant", { code: 1, stdout: JSON.stringify({ data: { status: "error", profiles: [{ errorCode: "invalid_grant" }] } }) }],
    ["twg finding no OAuth sign-in to refresh", { code: 0, stdout: JSON.stringify({ data: { status: "not_applicable", rotated: false } }) }]
  ])("should be true when it is %s", (_label, r) => {
    // Act & Assert
    expect(twgRefreshRejected(r)).toBe(true);
  });

  it.each([
    ["a refresh that worked", { code: 0, stdout: JSON.stringify({ data: { status: "ok", rotated: true } }) }],
    [
      "a failure that is not Atlassian refusing the token",
      { code: 1, stdout: JSON.stringify({ data: { status: "error", profiles: [{ errorCode: "network_error" }] } }) }
    ],
    ["a failure with no JSON", { code: 1, stdout: "Error: could not write the credentials file." }]
  ])("should be false when it is %s", (_label, r) => {
    // Act & Assert
    expect(twgRefreshRejected(r)).toBe(false);
  });
});

describe("twgDir", () => {
  it("should prefer TWG_CONFIG_DIR, then HOME, when both are set", () => {
    // Act & Assert
    expect(twgDir({ TWG_CONFIG_DIR: "/cfg", HOME: "/home/olive" })).toBe("/cfg");
    expect(twgDir({ HOME: "/home/olive" })).toBe("/home/olive/.config/twg");
  });
});

describe("restoreAtlassianAuth", () => {
  it("should write auth.conf readable only by the pod, in a directory only the pod can enter", () => {
    // Arrange
    const env = pod.env();

    // Act
    restoreAtlassianAuth(packAtlassianAuth(twgAuthConf()).value, { env });

    // Assert
    const file = path.join(env.TWG_CONFIG_DIR as string, "auth.conf");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(env.TWG_CONFIG_DIR as string).mode & 0o777).toBe(0o700);
    expect(readAtlassianAuth(env)).not.toContain("oauth-access-token");
  });

  it("should write auth-profiles.json and remove an auth.conf beside it when the sign-in is from twg 1.3.9", () => {
    // Arrange
    const env = pod.env();
    pod.seedTwg(env);

    // Act
    restoreAtlassianAuth(packAtlassianAuth(twgProfiles()).value, { env });

    // Assert
    const dir = env.TWG_CONFIG_DIR as string;
    expect(fs.existsSync(path.join(dir, "auth.conf"))).toBe(false);
    expect(fs.statSync(path.join(dir, "auth-profiles.json")).mode & 0o777).toBe(0o600);
    expect(readAtlassianAuth(env)).toBe(`${packAtlassianAuth(twgProfiles()).value}\n`);
  });

  it("should write auth.conf and remove an auth-profiles.json beside it when the sign-in is from twg 1.3.3", () => {
    // Arrange
    const env = v139();
    pod.seedTwg(env);

    // Act
    restoreAtlassianAuth(packAtlassianAuth(twgAuthConf()).value, { env });

    // Assert
    expect(fs.existsSync(path.join(env.TWG_CONFIG_DIR as string, "auth-profiles.json"))).toBe(false);
    expect(readAtlassianAuth(env)).toMatch(/^oauth-refresh-token=/m);
  });
});

describe("syncAtlassianAuth", () => {
  it("should refresh twg when due and store only a changed sign-in", async () => {
    // Arrange
    const env = pod.env();
    pod.seedTwg(env);
    const sync = (opts: { force?: boolean; refresh?: boolean } = {}) => syncAtlassianAuth({ api: api(), id: VID, env, ...opts });

    // Act & Assert: nothing is stored, and nothing is refreshed, until atlassian-login has stored a sign-in.
    expect(await sync({ refresh: true })).toBe("not-signed-in");
    expect(fs.existsSync(path.join(pod.stateDir, "twg.log"))).toBe(false);

    expect(await sync({ force: true })).toBe("stored");
    expect(await sync({ refresh: true })).toBe("unchanged");

    // A new access token alone is not a change.
    const file = path.join(env.TWG_CONFIG_DIR as string, "auth.conf");
    fs.writeFileSync(file, twgAuthConf({ refresh: `${TWG_REFRESH}-0`, access: "a-new-access-token" }));
    expect(await sync()).toBe("unchanged");

    // Once the refresh is due, twg rotates the refresh token and the rotated one is stored.
    fs.writeFileSync(path.join(pod.stateDir, "twg-due"), "");
    expect(await sync({ refresh: true })).toBe("stored");
    expect(storedAtlassian()).toMatch(rotatedTo(1));
  });

  it("should log the refusal and leave the sign-in alone when twg no longer accepts it", async () => {
    // Arrange
    const env = pod.env();
    pod.seedTwg(env);
    await syncAtlassianAuth({ api: api(), id: VID, env, force: true });
    fs.writeFileSync(path.join(pod.stateDir, "twg-valid"), "spent elsewhere");

    // Act
    const { result, stderr } = await captureStderr(() => syncAtlassianAuth({ api: api(), id: VID, env, refresh: true }));

    // Assert
    expect(result).toBe("unchanged");
    expect(stderr).toMatch(/twg auth refresh exited 77/);
    expect(noTwgSecret(stderr)).toBe(true);
  });

  it("should go on storing a rotated token while the hub is between replicas, rather than leave it a spent one", async () => {
    // Arrange: the token twg has just rotated to is the only one Atlassian will take, so a store that gives up
    // leaves the hub a token the next boot is refused on. Three refusals outlast the budget this store once had.
    const env = pod.env();
    pod.seedTwg(env);
    await syncAtlassianAuth({ api: api(), id: VID, env, force: true });
    fs.writeFileSync(path.join(pod.stateDir, "twg-due"), "");
    const hubApi = api();
    let puts = 0;
    const rolling = {
      putCredential: (id: string, kind: CredentialKind, value: string) => {
        puts += 1;
        return puts <= 3
          ? Promise.reject(new ApiError(503, { error: "no ready replica" }, "PUT", `/api/virtual/${id}/credentials/${kind}`))
          : hubApi.putCredential(id, kind, value);
      }
    };

    // Act
    const result = await syncAtlassianAuth({ api: rolling, id: VID, env, refresh: true });

    // Assert
    expect(result).toBe("stored");
    expect(puts).toBe(4);
    expect(storedAtlassian()).toMatch(rotatedTo(1));
  });

  it("should report no login when forced with nothing on disk", async () => {
    // Act & Assert
    expect(await syncAtlassianAuth({ api: api(), id: VID, env: pod.env(), force: true })).toBe("no-login");
  });

  it("should report no login, not a packing error, when the refresh leaves no auth.conf behind", async () => {
    // Arrange
    const env = pod.env({ FAKE_TWG_REFRESH_WIPES: "1" });
    pod.seedTwg(env);
    await syncAtlassianAuth({ api: api(), id: VID, env: pod.env(), force: true });

    // Act
    const { result, stderr } = await captureStderr(() => syncAtlassianAuth({ api: api(), id: VID, env, refresh: true }));

    // Assert
    expect(result).toBe("no-login");
    expect(stderr).toMatch(/twg auth refresh exited 1/);
    expect(stderr).not.toMatch(/oauth-refresh-token/);
  });
});

describe("atlassianLogin", () => {
  it("should restore the stored sign-in, refresh it and store the rotated one", async () => {
    // Arrange
    const env = pod.env();
    await api().putCredential(VID, "atlassian", packAtlassianAuth(twgAuthConf({ refresh: `${TWG_REFRESH}-0` })).value);
    fs.writeFileSync(path.join(pod.stateDir, "twg-valid"), `${TWG_REFRESH}-0`);

    // Act
    const { result, stderr } = await captureStderr(() => atlassianLogin({ api: api(), env }));

    // Assert
    expect(result).toBe("restored");
    expect(twgLog()).toMatch(/^auth refresh --force -o json$/m);
    const file = path.join(env.TWG_CONFIG_DIR as string, "auth.conf");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(env.TWG_CONFIG_DIR as string).mode & 0o777).toBe(0o700);
    expect(storedAtlassian()).toMatch(rotatedTo(1));
    expect(storedAtlassian()).not.toContain("oauth-access-token");
    expect(virtual().prompts).toHaveLength(0);
    expect(virtual().completes).toEqual([]);
    expect(noTwgSecret(stderr)).toBe(true);
  });

  it("should relay the twg device code, answer its browser prompt and store the sign-in", async () => {
    // Arrange
    const env = pod.env({ FAKE_TWG_USER: "olive.owner@justice.gov.uk" });

    // Act
    const { result, stderr } = await captureStderr(() => atlassianLogin({ api: api(), env }));

    // Assert
    expect(result).toBe("signed-in");
    // The hub is told twg's own limit, not the server's `expires_in`: the owner's countdown has to be the real one.
    expect(virtual().prompts).toEqual([{ kind: "atlassian", prompt: "device_code", verification_uri: TWG_URL, user_code: TWG_CODE, expires_in: 120 }]);
    expect(virtual().status[0]?.phase).toBe("awaiting_login");
    expect(virtual().status[0]?.detail).toMatch(new RegExp(`atlassian: .*${TWG_CODE}`));
    expect(virtual().completes).toEqual([{ kind: "atlassian", account_label: "olive.owner@justice.gov.uk" }]);
    expect(virtual().loginFailures).toEqual([]);
    expect(storedAtlassian()).toMatch(rotatedTo(1));
    expect(storedAtlassian()).not.toContain("oauth-access-token");
    expect(twgLog()).toMatch(/^login --site hmcts$/m);
    expect(noTwgSecret(stderr)).toBe(true);
  });

  it("should keep the rotated token stored when twg then fails, and carry on from it on a retry", async () => {
    // Arrange
    const env = pod.env();
    await api().putCredential(VID, "atlassian", packAtlassianAuth(twgAuthConf({ refresh: `${TWG_REFRESH}-0` })).value);
    fs.writeFileSync(path.join(pod.stateDir, "twg-valid"), `${TWG_REFRESH}-0`);

    // Act
    const failed = await captureStderrOfFailure(() => atlassianLogin({ api: api(), env: pod.env({ FAKE_TWG_DOCTOR_FAILS: "1" }) }));

    // Assert
    expect((failed.error as Error).message).toMatch(/twg doctor cannot reach Atlassian/);
    expect(storedAtlassian()).toMatch(rotatedTo(1));

    // Act: the hub is behind the pod when a store failed, so the pod's own sign-in is used, not the hub's
    // spent one.
    virtual().credentials.set("atlassian", packAtlassianAuth(twgAuthConf({ refresh: `${TWG_REFRESH}-0` })).value);
    const { result, stderr } = await captureStderr(() => atlassianLogin({ api: api(), env }));

    // Assert
    expect(result).toBe("restored");
    expect(stderr).toMatch(/kept the current sign-in/);
    expect(storedAtlassian()).toMatch(rotatedTo(2));
    expect(virtual().prompts).toHaveLength(0);
  });

  it("should sign in again when the stored sign-in has been spent", async () => {
    // Arrange
    await api().putCredential(VID, "atlassian", packAtlassianAuth(twgAuthConf({ refresh: `${TWG_REFRESH}-old` })).value);
    fs.writeFileSync(path.join(pod.stateDir, "twg-valid"), `${TWG_REFRESH}-elsewhere`);

    // Act
    const { result, stderr } = await captureStderr(() => atlassianLogin({ api: api(), env: pod.env() }));

    // Assert
    expect(result).toBe("signed-in");
    expect(stderr).toMatch(/the stored sign-in no longer works; signing in again/);
    expect(virtual().prompts).toHaveLength(1);
    expect(storedAtlassian()).toMatch(rotatedTo(1));
  });

  it("should sign in again when the stored sign-in cannot be restored at all", async () => {
    // Arrange
    await api().putCredential(VID, "atlassian", "not an auth.conf");

    // Act
    const { result, stderr } = await captureStderr(() => atlassianLogin({ api: api(), env: pod.env() }));

    // Assert
    expect(result).toBe("signed-in");
    expect(stderr).toMatch(/atlassian: could not restore the stored sign-in \(.*\); signing in again/);
    expect(storedAtlassian()).toMatch(rotatedTo(1));
  });

  it("should leave Jira and Confluence signed out, and tell the hub, when the sign-in breaks rather than runs out", async () => {
    // Act
    const { result, stderr } = await captureStderr(() => atlassianLogin({ api: api(), env: pod.env({ FAKE_TWG_LOGIN: "deny" }) }));

    // Assert: a sign-in the owner refused is not one they missed, so no second code is offered
    expect(result).toBe("not-signed-in");
    expect(stderr).toMatch(/sign-in was not completed .*Jira and Confluence stay signed out/);
    expect(virtual().prompts).toHaveLength(1);
    expect(virtual().loginFailures).toEqual([{ kind: "atlassian", state: "failed", detail: expect.stringContaining("was not completed") }]);
    expect(virtual().credentials.has("atlassian")).toBe(false);
    expect(virtual().completes).toEqual([]);
  });

  it("should restore a stored twg 1.3.9 sign-in, refresh it and store the rotated one without its access token", async () => {
    // Arrange
    const env = v139();
    await api().putCredential(VID, "atlassian", packAtlassianAuth(twgProfiles({ refresh: `${TWG_REFRESH}-0` })).value);
    fs.writeFileSync(path.join(pod.stateDir, "twg-valid"), `${TWG_REFRESH}-0`);

    // Act
    const { result, stderr } = await captureStderr(() => atlassianLogin({ api: api(), env }));

    // Assert
    expect(result).toBe("restored");
    expect(storedProfile()?.credentials.primary.oauthRefreshToken).toBe(`${TWG_REFRESH}-1`);
    expect(storedProfile()?.credentials.primary.oauthAccessToken).toBe("");
    expect(virtual().prompts).toHaveLength(0);
    expect(noTwgSecret(stderr)).toBe(true);
  });

  it("should sign in again when twg 1.3.9 reports the stored sign-in refused", async () => {
    // Arrange
    await api().putCredential(VID, "atlassian", packAtlassianAuth(twgProfiles({ refresh: `${TWG_REFRESH}-old` })).value);
    fs.writeFileSync(path.join(pod.stateDir, "twg-valid"), `${TWG_REFRESH}-elsewhere`);

    // Act
    const { result, stderr } = await captureStderr(() => atlassianLogin({ api: api(), env: v139() }));

    // Assert
    expect(result).toBe("signed-in");
    expect(stderr).toMatch(/the stored sign-in no longer works; signing in again/);
    expect(virtual().prompts).toHaveLength(1);
    expect(storedProfile()?.credentials.primary.oauthRefreshToken).toBe(`${TWG_REFRESH}-1`);
  });

  it("should store twg 1.3.9's auth-profiles.json labelled with its account when the owner signs in", async () => {
    // Act
    const { result } = await captureStderr(() => atlassianLogin({ api: api(), env: v139({ FAKE_TWG_USER: "olive.owner@justice.gov.uk" }) }));

    // Assert
    expect(result).toBe("signed-in");
    expect(virtual().completes).toEqual([{ kind: "atlassian", account_label: "olive.owner@justice.gov.uk" }]);
    expect(storedProfile()?.credentials.primary.oauthAccessToken).toBe("");
    expect(storedProfile()?.credentials.primary.oauthRefreshToken).toBe(`${TWG_REFRESH}-1`);
  });

  it("should offer another code, and then report the sign-in expired, when twg says its code ran out", async () => {
    // Arrange: twg's own timeout, which it reports in two seconds here and in two minutes in a pod. Nothing waits
    // out a clock: the bracketed error code is what says the code ran out rather than the sign-in breaking.
    const env = pod.env({ FAKE_TWG_LOGIN: "expire" });

    // Act
    const { result, stderr } = await captureStderr(() => atlassianLogin({ api: api(), env }));

    // Assert
    expect(result).toBe("not-signed-in");
    expect(virtual().prompts).toHaveLength(ATLASSIAN_SIGN_IN_CODES);
    expect(stderr).toMatch(/ran out before it was used; relaying a fresh one/);
    expect(virtual().loginFailures).toEqual([{ kind: "atlassian", state: "expired", detail: expect.stringContaining("ran out before it was used") }]);
    expect(virtual().completes).toEqual([]);
  });

  it("should offer no code beyond the bound, however long the owner takes", async () => {
    // Arrange
    const env = pod.env({ FAKE_TWG_LOGIN: "expire" });

    // Act
    await captureStderr(() => atlassianLogin({ api: api(), env, codes: ATLASSIAN_SIGN_IN_CODES + 2 }));

    // Assert: the bound is the only thing that stops it, so it is what the count follows
    expect(virtual().prompts).toHaveLength(ATLASSIAN_SIGN_IN_CODES + 2);
    expect(virtual().loginFailures).toHaveLength(1);
  });

  it("should report the owner's last code inside the time the session gives the export command", () => {
    // Act & Assert: killed at the Bash timeout, the command reports nothing and the dead code stays on the owner's
    // screen, which is the fault this whole path exists to prevent. The code count is bounded by this, not by taste.
    expect(TWG_DEVICE_CODE_EXPIRES_S).toBe(120);
    expect(jiraExportSignInBudget()).toBeLessThan(JIRA_EXPORT_BASH_TIMEOUT_MS);
  });

  it("should not fit another code into that time, which is why the bound is where it is", () => {
    // Act & Assert
    expect(jiraExportSignInBudget(ATLASSIAN_SIGN_IN_CODES + 1)).toBeGreaterThan(JIRA_EXPORT_BASH_TIMEOUT_MS);
  });

  it("should stay signed out, and say why, when the hub will not take the report", async () => {
    // Arrange
    const refusing: Api = {
      ...api(),
      loginFailed: () => Promise.reject(new ApiError(404, { error: "there is no atlassian sign-in to report on" }, "POST", "login/atlassian/failed"))
    };

    // Act
    const { result, stderr } = await captureStderr(() => atlassianLogin({ api: refusing, env: pod.env({ FAKE_TWG_LOGIN: "deny" }) }));

    // Assert
    expect(result).toBe("not-signed-in");
    expect(stderr).toMatch(/could not tell agent-hub the sign-in was not completed/);
  });

  it("should say an agent-hub that has no route for the report is older than this client, and say it quietly", async () => {
    // Arrange: a client published ahead of the deploy carrying its route gets the hub's own not-found page. The
    // deploy behind it puts this right, so it is worth one plain sentence and none of the document.
    const page = '<!DOCTYPE html><html lang="en" class="dark h-full"><head><meta charSet="utf-8"/>';
    const older: Api = {
      ...api(),
      loginFailed: () => Promise.reject(new ApiError(404, { error: page }, "POST", `/api/virtual/${VID}/login/atlassian/failed`))
    };

    // Act
    const { result, stderr } = await captureStderr(() => atlassianLogin({ api: older, env: pod.env({ FAKE_TWG_LOGIN: "deny" }) }));

    // Assert
    expect(result).toBe("not-signed-in");
    expect(stderr.match(/older than this client/g)).toHaveLength(1);
    expect(stderr).not.toMatch(/could not tell agent-hub/);
    expect(stderr).not.toMatch(/DOCTYPE|<html|charSet/);
  });

  it("should still say loudly that the report did not land when agent-hub answers with a fault", async () => {
    // Arrange
    const broken: Api = {
      ...api(),
      loginFailed: () => Promise.reject(new ApiError(500, { error: "could not record the sign-in" }, "POST", `/api/virtual/${VID}/login/atlassian/failed`))
    };

    // Act
    const { stderr } = await captureStderr(() => atlassianLogin({ api: broken, env: pod.env({ FAKE_TWG_LOGIN: "deny" }) }));

    // Assert
    expect(stderr).toMatch(/could not tell agent-hub the sign-in was not completed \(.*500 could not record the sign-in\)/);
    expect(stderr).not.toMatch(/older than this client/);
  });

  it("should fail without failing the agent when twg prints no code at all", async () => {
    // Act
    const { error } = await captureStderrOfFailure(() => atlassianLogin({ api: api(), env: pod.env({ FAKE_TWG_LOGIN: "crash" }) }));

    // Assert
    expect((error as Error).message).toMatch(/printed no sign-in code/);
    expect(virtual().status.some((s) => s.phase === "failed")).toBe(false);
  });

  it("should tell both the hub and the Jira export when the owner lets every code expire", async () => {
    // Arrange: `agent-hub jira export` drives this sign-in, as `cli.ts` wires it, and is the only thing that puts
    // the export back in front of the person. Both reports have to come out of the one run: the sign-in's, so their
    // screens stop offering a dead code, and the export's, so the button comes back with a reason on it.
    const reports: JiraExportReport[] = [];
    const hubApi = api();
    const deps = {
      api: {
        getArtefact: async (): Promise<Artefact> => ({
          title: "Fee stories",
          markdown: "# Stories\n\nAs a claimant…",
          version: 3,
          updated_by: "agent",
          updated_at: null
        }),
        putJiraExport: async (_agentId: string, body: JiraExportReport) => {
          reports.push(body);
          return null;
        }
      },
      agentId: "a-conversation",
      env: pod.env({ FAKE_TWG_LOGIN: "expire" }),
      run,
      login: () => atlassianLogin({ api: hubApi, env: pod.env({ FAKE_TWG_LOGIN: "expire" }) }),
      print: () => {},
      dir: fs.mkdtempSync(path.join(os.tmpdir(), "atlassian-export-"))
    };

    // Act
    const { result: outcome } = await captureStderr(() =>
      runJiraExport(deps, { exportId: "5b0e7c1a-1111-4222-8333-444455556666", project: "VIBE", issueType: "Story", labels: [] })
    );

    // Assert
    expect(virtual().prompts).toHaveLength(ATLASSIAN_SIGN_IN_CODES);
    expect(virtual().loginFailures).toEqual([{ kind: "atlassian", state: "expired", detail: expect.stringContaining("ran out before it was used") }]);
    expect(outcome).toEqual({ error: "The Atlassian sign-in was not completed, so the ticket could not be created." });
    expect(reports).toEqual([
      { export_id: "5b0e7c1a-1111-4222-8333-444455556666", error: "The Atlassian sign-in was not completed, so the ticket could not be created." }
    ]);
  });

  it("should still report the sign-in when a later attempt throws, so no dead code is left with the hub", async () => {
    // Arrange: the first code runs out and the second attempt finds no twg at all, which `relayDeviceLogin` throws on
    const env = pod.env({ FAKE_TWG_LOGIN: "expire" });
    const onSecond = {
      ...api(),
      loginPrompt: async (id: string, kind: CredentialKind, body: LoginPromptBody) => {
        if (virtual().prompts.length > 0) {
          throw new ApiError(400, { error: "hub down" }, "POST", `login/${kind}`);
        }
        return await api().loginPrompt(id, kind, body);
      }
    } satisfies Api;

    // Act
    const { error, stderr } = await captureStderrOfFailure(() => atlassianLogin({ api: onSecond, env }));

    // Assert
    expect((error as Error).message).toMatch(/could not relay the atlassian sign-in code/);
    expect(virtual().loginFailures).toEqual([{ kind: "atlassian", state: "failed", detail: expect.stringContaining("could not be relayed") }]);
    expect(stderr).toMatch(/the sign-in could not be relayed/);
  });
});
