// The Azure sign-in a pod keeps on the hub: what is pruned out of the MSAL cache before it is stored, how it
// is restored into a fresh pod, and when a changed cache is uploaded again.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMockHub, type MockHub } from "../__fixtures__/mock-hub.ts";
import { createPodShims, msalCache, type PodShims, podSecrets, usePodEnv } from "../__fixtures__/pod-shims.ts";
import { createApi } from "../api.ts";
import { sha256 } from "../session.ts";
import {
  AZURE_CACHE_MAX_CHARS,
  azureDir,
  minimalProfile,
  packAzureCache,
  pruneMsalCache,
  readAzureCache,
  restoreAzureCache,
  syncAzureCache,
  unpackAzureCache
} from "./azure-cache.ts";

const VID = "va-azure-cache";
const OWNER = { oid: "oid-owner", name: "Olive Owner", email: "olive@example.com" };
const REFRESH = podSecrets.azureRefresh;

let hub: MockHub;
let url: string;
let pod: PodShims;
let restoreEnv: () => void;

beforeAll(async () => {
  hub = createMockHub({ launchTokens: { [podSecrets.launchToken]: { virtualId: VID, owner: OWNER } } });
  url = await hub.listen();
  pod = createPodShims({ virtualId: VID, hubUrl: url });
  restoreEnv = usePodEnv(pod.home);
});

afterEach(() => {
  (hub.virtuals.get(VID) as { credentials: Map<string, string> }).credentials.clear();
  pod.reset();
});

afterAll(async () => {
  await hub.close();
  restoreEnv();
  pod.cleanup();
});

const api = () => createApi({ baseUrl: url, launchToken: podSecrets.launchToken });
const refreshSecret = (value: string) => ((unpackAzureCache(value).RefreshToken as Record<string, { secret: string }>)["rt-1"] as { secret: string }).secret;

// Random bytes so gzip cannot shrink them.
const noise = (n: number) => Buffer.from(Array.from({ length: n }, () => Math.floor(Math.random() * 256))).toString("base64");

describe("pruneMsalCache", () => {
  it("should drop the access tokens and keep everything else when given a cache az wrote", () => {
    // Arrange
    const cache = msalCache();

    // Act
    const pruned = pruneMsalCache(cache);

    // Assert
    expect(pruned.AccessToken).toBeUndefined();
    expect(Object.keys(pruned).sort((a, b) => a.localeCompare(b))).toEqual(["Account", "AppMetadata", "IdToken", "RefreshToken"]);
  });
});

describe("packAzureCache", () => {
  it("should gzip and base64 the pruned cache so it unpacks to the same thing when given a cache az wrote", () => {
    // Arrange
    const cache = msalCache();

    // Act
    const { value, sha } = packAzureCache(JSON.stringify(cache));
    const unpacked = unpackAzureCache(value);

    // Assert
    expect(unpacked).toEqual(pruneMsalCache(cache));
    expect(unpacked.AccessToken).toBeUndefined();
    expect(refreshSecret(value)).toBe(REFRESH);
    expect(
      (JSON.parse(zlib.gunzipSync(Buffer.from(value, "base64")).toString("utf8")) as { RefreshToken: Record<string, { secret: string }> }).RefreshToken["rt-1"]
        ?.secret
    ).toBe(REFRESH);
    expect(sha).toBe(sha256(JSON.stringify(pruneMsalCache(cache))));
  });

  it("should give the same sha when only the access tokens are new", () => {
    // Arrange
    const cache = msalCache();
    const { sha } = packAzureCache(JSON.stringify(cache));

    // Act
    const again = packAzureCache(JSON.stringify({ ...cache, AccessToken: { other: { secret: "new" } } }));

    // Assert
    expect(again.sha).toBe(sha);
  });

  it("should drop the id tokens too when the pruned cache is over the hub's cap", () => {
    // Arrange
    const bigId = { ...msalCache(), IdToken: { big: { secret: noise(30000) } } };

    // Act
    const { value, cache } = packAzureCache(JSON.stringify(bigId));

    // Assert
    expect(value.length).toBeLessThanOrEqual(AZURE_CACHE_MAX_CHARS);
    expect(cache.IdToken).toBeUndefined();
    expect(refreshSecret(value)).toBe(REFRESH);
  });

  it("should refuse the cache when dropping the id tokens is not enough", () => {
    // Arrange
    const bigRefresh = msalCache({ refresh: noise(30000) });

    // Act & Assert
    expect(() => packAzureCache(JSON.stringify(bigRefresh))).toThrow(/over the hub's 24000/);
  });

  it("should refuse a cache that is not an object rather than storing an empty one", () => {
    // Act & Assert: the .mjs stored `{}` here, which would overwrite a good sign-in on the hub with nothing.
    expect(() => packAzureCache("5")).toThrow(/not an object/);
    expect(() => packAzureCache("{not json")).toThrow();
  });
});

describe("unpackAzureCache", () => {
  it("should refuse a stored cache with no refresh token when given one az cannot use", () => {
    // Act & Assert
    expect(() => unpackAzureCache(zlib.gzipSync('{"Account":{}}').toString("base64"))).toThrow(/no refresh token/);
  });
});

describe("minimalProfile", () => {
  it("should name the account from the cache when the tenant is not given", () => {
    // Act
    const profile = minimalProfile(pruneMsalCache(msalCache()));

    // Assert
    expect(profile.subscriptions[0]?.user.name).toBe("olive@hmcts.net");
    expect(profile.subscriptions[0]?.tenantId).toBe("531ff96d-0ae9-462a-8d2d-bec7c0b42082");
  });

  it("should leave the tenant unset when the cache holds no account", () => {
    // Act
    const profile = minimalProfile({});

    // Assert
    expect(profile.subscriptions[0]?.tenantId).toBeUndefined();
    expect(profile.subscriptions[0]?.name).toBe("N/A(tenant level account)");
  });
});

describe("azureDir", () => {
  it("should prefer AZURE_CONFIG_DIR, then HOME, when both are set", () => {
    // Act & Assert
    expect(azureDir({ AZURE_CONFIG_DIR: "/cfg", HOME: "/home/olive" })).toBe("/cfg");
    expect(azureDir({ HOME: "/home/olive" })).toBe("/home/olive/.azure");
  });
});

describe("restoreAzureCache", () => {
  it("should write the cache and a tenant-level profile, readable only by the pod, when the hub holds a sign-in", () => {
    // Arrange
    const env = pod.env();
    const { value } = packAzureCache(JSON.stringify(msalCache()));

    // Act
    restoreAzureCache(value, { env });

    // Assert
    const dir = env.AZURE_CONFIG_DIR as string;
    expect(JSON.parse(fs.readFileSync(path.join(dir, "msal_token_cache.json"), "utf8"))).toEqual(unpackAzureCache(value));
    expect(fs.statSync(path.join(dir, "msal_token_cache.json")).mode & 0o777).toBe(0o600);
    const profile = JSON.parse(fs.readFileSync(path.join(dir, "azureProfile.json"), "utf8")) as {
      subscriptions: { user: { name: string }; tenantId: string }[];
    };
    expect(profile.subscriptions[0]?.user.name).toBe("olive@hmcts.net");
    expect(profile.subscriptions[0]?.tenantId).toBe(env.AZURE_TENANT_ID);
  });

  it("should keep a profile that is already there when the pod has signed in before", () => {
    // Arrange
    const env = pod.env();
    fs.mkdirSync(env.AZURE_CONFIG_DIR as string, { recursive: true });
    fs.writeFileSync(path.join(env.AZURE_CONFIG_DIR as string, "azureProfile.json"), '{"mine":true}');

    // Act
    restoreAzureCache(packAzureCache(JSON.stringify(msalCache())).value, { env });

    // Assert
    expect(fs.readFileSync(path.join(env.AZURE_CONFIG_DIR as string, "azureProfile.json"), "utf8")).toBe('{"mine":true}');
  });
});

describe("readAzureCache", () => {
  it("should be null when the pod has no cache on disk", () => {
    // Act & Assert
    expect(readAzureCache(pod.env())).toBeNull();
  });
});

describe("syncAzureCache", () => {
  it("should store the cache only when its pruned content changed", async () => {
    // Arrange
    const env = pod.env();
    const file = path.join(env.AZURE_CONFIG_DIR as string, "msal_token_cache.json");
    const sync = () => syncAzureCache({ api: api(), id: VID, env });

    // Act & Assert: nothing on disk yet.
    expect(await sync()).toBe("no-cache");

    fs.mkdirSync(env.AZURE_CONFIG_DIR as string, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(msalCache()));
    expect(await sync()).toBe("stored");
    expect(await sync()).toBe("unchanged");

    fs.writeFileSync(file, JSON.stringify(msalCache({ accessTokens: 5 })));
    expect(await sync()).toBe("unchanged");

    fs.writeFileSync(file, JSON.stringify(msalCache({ refresh: `${REFRESH}-rotated` })));
    expect(await sync()).toBe("stored");
    expect(refreshSecret((hub.virtuals.get(VID) as { credentials: Map<string, string> }).credentials.get("azure") as string)).toBe(`${REFRESH}-rotated`);
  });

  it("should store an unchanged cache anyway when forced", async () => {
    // Arrange
    const env = pod.env();
    fs.mkdirSync(env.AZURE_CONFIG_DIR as string, { recursive: true });
    fs.writeFileSync(path.join(env.AZURE_CONFIG_DIR as string, "msal_token_cache.json"), JSON.stringify(msalCache()));
    await syncAzureCache({ api: api(), id: VID, env });

    // Act & Assert
    expect(await syncAzureCache({ api: api(), id: VID, env, force: true })).toBe("stored");
  });
});
