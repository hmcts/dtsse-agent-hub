// The twg (Jira, Confluence) sign-in a pod keeps on the hub, against a fake twg that rotates both tokens on
// every refresh and accepts only the newest refresh token — which is what makes storing the rotated one
// before anything else can fail the thing worth testing.
import fs from "node:fs";
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
  TWG_LOGIN_OUTPUT,
  TWG_URL,
  twgAuthConf,
  usePodEnv
} from "../__fixtures__/pod-shims.ts";
import { createApi } from "../api.ts";
import {
  atlassianLogin,
  packAtlassianAuth,
  parseTwgDeviceCode,
  readAtlassianAuth,
  restoreAtlassianAuth,
  syncAtlassianAuth,
  twgDir,
  twgPromptsForBrowser
} from "./atlassian.ts";

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

  it("should report no login when forced with nothing on disk", async () => {
    // Act & Assert
    expect(await syncAtlassianAuth({ api: api(), id: VID, env: pod.env(), force: true })).toBe("no-login");
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
    expect(twgLog()).toMatch(/^auth refresh --force$/m);
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
    expect(virtual().prompts).toEqual([{ kind: "atlassian", prompt: "device_code", verification_uri: TWG_URL, user_code: TWG_CODE, expires_in: 300 }]);
    expect(virtual().status[0]?.phase).toBe("awaiting_login");
    expect(virtual().status[0]?.detail).toMatch(new RegExp(`atlassian: .*${TWG_CODE}`));
    expect(virtual().completes).toEqual([{ kind: "atlassian", account_label: "olive.owner@justice.gov.uk" }]);
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

  it("should leave Jira and Confluence signed out when the device code expires", async () => {
    // Act
    const { result, stderr } = await captureStderr(() => atlassianLogin({ api: api(), env: pod.env({ FAKE_TWG_LOGIN: "expire" }) }));

    // Assert
    expect(result).toBe("not-signed-in");
    expect(stderr).toMatch(/sign-in was not completed .*Jira and Confluence stay signed out/);
    expect(virtual().prompts).toHaveLength(1);
    expect(virtual().credentials.has("atlassian")).toBe(false);
    expect(virtual().completes).toEqual([]);
  });

  it("should fail without failing the agent when twg prints no code at all", async () => {
    // Act
    const { error } = await captureStderrOfFailure(() => atlassianLogin({ api: api(), env: pod.env({ FAKE_TWG_LOGIN: "crash" }) }));

    // Assert
    expect((error as Error).message).toMatch(/printed no sign-in code/);
    expect(virtual().status.some((s) => s.phase === "failed")).toBe(false);
  });
});
