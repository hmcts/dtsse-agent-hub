// The loop that keeps the hub's copy of a pod's sign-ins current. The workspace suite ran this as a child
// process so it could send a real SIGTERM; in process the signal is emitted directly, which runs the same
// handler without killing the test runner.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMockHub, type MockHub } from "../__fixtures__/mock-hub.ts";
import { captureStderr, createPodShims, msalCache, type PodShims, podSecrets, twgAuthConf, usePodEnv } from "../__fixtures__/pod-shims.ts";
import { type Api, createApi } from "../api.ts";
import { syncAtlassianAuth } from "./atlassian.ts";
import { unpackAzureCache } from "./azure-cache.ts";
import { cacheSync } from "./cache-sync.ts";

const VID = "va-cache-sync";
const OWNER = { oid: "oid-owner", name: "Olive Owner", email: "olive@example.com" };
const LAUNCH = podSecrets.launchToken;
const REFRESH = podSecrets.azureRefresh;
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
  virtual().credentials.clear();
  virtual().status.length = 0;
  pod.reset();
});

afterAll(async () => {
  await hub.close();
  restoreEnv();
  pod.cleanup();
});

const virtual = () => hub.virtuals.get(VID) as NonNullable<ReturnType<MockHub["virtuals"]["get"]>>;
const api = () => createApi({ baseUrl: url, launchToken: LAUNCH });
const storedAtlassian = () => virtual().credentials.get("atlassian") as string;
const atlassianPuts = () => hub.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/credentials/atlassian")).length;
const azureRefreshSecret = () =>
  ((unpackAzureCache(virtual().credentials.get("azure") as string).RefreshToken as Record<string, { secret: string }>)["rt-1"] as { secret: string }).secret;
const writeAzureCache = (env: Record<string, string>, body: string) => {
  fs.mkdirSync(env.AZURE_CONFIG_DIR as string, { recursive: true });
  fs.writeFileSync(path.join(env.AZURE_CONFIG_DIR as string, "msal_token_cache.json"), body);
};
const poll = async (ready: () => boolean, what: string) => {
  const deadline = Date.now() + 10000;
  while (!ready() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!ready()) {
    throw new Error(`timed out waiting for ${what}`);
  }
};

describe("cacheSync --once", () => {
  it("should report nothing to do when the pod has neither sign-in", async () => {
    // Act
    const result = await cacheSync({ api: api(), env: pod.env(), once: true });

    // Assert
    expect(result).toEqual({ azure: "no-cache", atlassian: "not-signed-in" });
  });

  it("should store the twg sign-in even when the Azure cache cannot be read", async () => {
    // Arrange: Claude's own twg calls rotate the sign-in too, and a broken azure cache must not stop it
    // being stored.
    const env = pod.env();
    pod.seedTwg(env);
    await syncAtlassianAuth({ api: api(), id: VID, env, force: true });
    writeAzureCache(env, "{not json");
    fs.writeFileSync(path.join(env.TWG_CONFIG_DIR as string, "auth.conf"), twgAuthConf({ refresh: `${TWG_REFRESH}-by-claude` }));
    const puts = atlassianPuts();

    // Act
    const { result, stderr } = await captureStderr(() => cacheSync({ api: api(), env, once: true }));

    // Assert
    expect(result).toEqual({ azure: "error", atlassian: "stored" });
    expect(stderr).toMatch(/azure: storing the token cache failed/);
    expect(stderr).toMatch(/atlassian: twg sign-in stored on agent-hub/);
    expect(atlassianPuts()).toBe(puts + 1);
    expect(storedAtlassian()).toMatch(new RegExp(`^oauth-refresh-token=${TWG_REFRESH}-by-claude$`, "m"));
  });

  it("should store the twg sign-in before the Azure cache, so the one that cannot be recovered goes first", async () => {
    // Arrange: on SIGTERM the pass shares the pod's last 60 seconds, and only the twg sign-in is unrecoverable
    // if it is lost — Atlassian takes only the newest refresh token, where a stale MSAL cache still refreshes.
    const env = pod.env();
    pod.seedTwg(env);
    await syncAtlassianAuth({ api: api(), id: VID, env, force: true });
    writeAzureCache(env, JSON.stringify(msalCache()));
    fs.writeFileSync(path.join(env.TWG_CONFIG_DIR as string, "auth.conf"), twgAuthConf({ refresh: `${TWG_REFRESH}-by-claude` }));
    const from = hub.calls.length;

    // Act
    const result = await cacheSync({ api: api(), env, once: true });

    // Assert
    expect(result).toEqual({ azure: "stored", atlassian: "stored" });
    const stores = hub.calls
      .slice(from)
      .filter((c) => c.method === "PUT" && /\/credentials\/(atlassian|azure)$/.test(c.path))
      .map((c) => c.path.split("/").pop());
    expect(stores).toEqual(["atlassian", "azure"]);
  });

  it("should report the twg sign-in as an error when auth.conf has lost its refresh token", async () => {
    // Arrange
    const env = pod.env();
    pod.seedTwg(env);
    await syncAtlassianAuth({ api: api(), id: VID, env, force: true });
    fs.writeFileSync(path.join(env.TWG_CONFIG_DIR as string, "auth.conf"), twgAuthConf({ refresh: "" }));

    // Act
    const { result, stderr } = await captureStderr(() => cacheSync({ api: api(), env, once: true }));

    // Assert
    expect(result.atlassian).toBe("error");
    expect(stderr).toMatch(/atlassian: storing the twg sign-in failed: .*no oauth-refresh-token/);
  });
});

describe("cacheSync", () => {
  it("should run until SIGTERM and store the Azure cache once more on the way out", async () => {
    // Arrange
    const env = pod.env({ AGENT_HUB_CACHE_SYNC_MS: "60000" });
    writeAzureCache(env, JSON.stringify(msalCache()));
    const listenersBefore = process.listenerCount("SIGTERM");

    // Act
    const { result, stderr } = await captureStderr(async () => {
      const running = cacheSync({ api: api(), env });
      await poll(() => virtual().credentials.has("azure"), "the first sync to store the cache");
      writeAzureCache(env, JSON.stringify(msalCache({ refresh: `${REFRESH}-final` })));
      process.emit("SIGTERM");
      return running;
    });

    // Assert
    expect(result).toEqual({ azure: "stored", atlassian: "not-signed-in" });
    expect(azureRefreshSecret()).toBe(`${REFRESH}-final`);
    expect(stderr).not.toContain(REFRESH);
    expect(process.listenerCount("SIGTERM")).toBe(listenersBefore);
  });

  it("should finish the pass it is in and then store once more when SIGTERM lands mid-pass", async () => {
    // Arrange: the signal only wakes the sleep, so a pass already running is not cut short — it refreshes and
    // stores to the end, and only then does the final store-only pass begin. How much of the pod's 60 seconds
    // that leaves the final pass is why a pass stores the twg sign-in before the Azure cache.
    const env = pod.env({ AGENT_HUB_CACHE_SYNC_MS: "60000" });
    pod.seedTwg(env);
    await syncAtlassianAuth({ api: api(), id: VID, env, force: true });
    fs.writeFileSync(path.join(pod.stateDir, "twg-due"), "");
    writeAzureCache(env, JSON.stringify(msalCache()));
    const hubApi = api();
    let signalled = false;
    const signalMidPass: Api = {
      ...hubApi,
      putCredential: (id, kind, value) => {
        if (!signalled) {
          signalled = true;
          process.emit("SIGTERM");
        }
        return hubApi.putCredential(id, kind, value);
      }
    };
    const listenersBefore = process.listenerCount("SIGTERM");

    // Act
    const { result } = await captureStderr(() => cacheSync({ api: signalMidPass, env }));

    // Assert: the interrupted pass still rotated and stored, and the final pass stored rather than refreshing
    expect(storedAtlassian()).toMatch(new RegExp(`^oauth-refresh-token=${TWG_REFRESH}-1$`, "m"));
    expect(virtual().credentials.has("azure")).toBe(true);
    expect(fs.readFileSync(path.join(pod.stateDir, "twg.log"), "utf8").match(/^auth refresh$/gm)).toHaveLength(1);
    expect(result).toEqual({ azure: "unchanged", atlassian: "unchanged" });
    expect(process.listenerCount("SIGTERM")).toBe(listenersBefore);
  });

  it("should refresh twg as it runs and store its rotated sign-in once more on SIGINT", async () => {
    // Arrange
    const env = pod.env({ AGENT_HUB_CACHE_SYNC_MS: "60000" });
    pod.seedTwg(env);
    await syncAtlassianAuth({ api: api(), id: VID, env, force: true });
    fs.writeFileSync(path.join(pod.stateDir, "twg-due"), "");

    // Act
    const { stderr } = await captureStderr(async () => {
      const running = cacheSync({ api: api(), env });
      await poll(() => /-1$/m.test(storedAtlassian() ?? ""), "the first run to refresh and store the sign-in");
      fs.rmSync(path.join(pod.stateDir, "twg-due"));
      fs.writeFileSync(path.join(env.TWG_CONFIG_DIR as string, "auth.conf"), twgAuthConf({ refresh: `${TWG_REFRESH}-final` }));
      process.emit("SIGINT");
      return running;
    });

    // Assert
    expect(storedAtlassian()).toMatch(new RegExp(`^oauth-refresh-token=${TWG_REFRESH}-final$`, "m"));
    expect(fs.readFileSync(path.join(pod.stateDir, "twg.log"), "utf8").match(/^auth refresh$/gm)).toHaveLength(1);
    expect(stderr).not.toContain(TWG_REFRESH);
  });
});
