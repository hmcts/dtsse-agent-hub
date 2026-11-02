// The pod's Azure sign-in, against the mock hub with a fake az on PATH that prints what the real one prints. No real
// sign-in is ever started, and every assertion that a secret stays off stderr is kept from the workspace suite.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AZ_OUTPUT, captureStderr, captureStderrOfFailure, msalCache, podSecrets } from "../__fixtures__/pod-shims.ts";
import { SIGN_IN_LAUNCH as LAUNCH, SIGN_IN_OWNER as OWNER, useSignInHub, SIGN_IN_VID as VID } from "../__fixtures__/sign-in-hub.ts";
import { type Api, ApiError } from "../api.ts";
import { packAzureCache, pruneMsalCache, unpackAzureCache } from "./azure-cache.ts";
import { azureLogin, parseAzDeviceCode } from "./azure-login.ts";
import { FatalError } from "./phases.ts";

const REFRESH = podSecrets.azureRefresh;

const { hub, pod, virtual, api } = await useSignInHub();
const azurePuts = () => hub.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/credentials/azure")).length;

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

  it("should restore a stored cache that works when it may only restore", async () => {
    // Arrange
    await api().putCredential(VID, "azure", packAzureCache(JSON.stringify(msalCache())).value);
    fs.writeFileSync(path.join(pod.stateDir, "az-ok"), "");

    // Act
    const { result } = await captureStderr(() => azureLogin({ api: api(), env: pod.env(), mode: "restore" }));

    // Assert
    expect(result).toBe("restored");
    expect(virtual().prompts).toHaveLength(0);
  });

  it("should relay nothing and say Azure stays unconfigured when it may only restore and nothing is stored", async () => {
    // Act
    const { result, stderr } = await captureStderr(() => azureLogin({ api: api(), env: pod.env(), mode: "restore" }));

    // Assert
    expect(result).toBe("not-connected");
    expect(virtual().prompts).toHaveLength(0);
    expect(virtual().status).toHaveLength(0);
    expect(stderr).toContain("azure: no sign-in is stored; Azure stays unconfigured until the owner connects it");
  });

  it("should relay nothing when it may only restore and the stored cache no longer works", async () => {
    // Arrange: no `az-ok`, so the restored sign-in fails `az account get-access-token`.
    await api().putCredential(VID, "azure", packAzureCache(JSON.stringify(msalCache())).value);

    // Act
    const { result, stderr } = await captureStderr(() => azureLogin({ api: api(), env: pod.env(), mode: "restore" }));

    // Assert
    expect(result).toBe("not-connected");
    expect(virtual().prompts).toHaveLength(0);
    expect(stderr).toContain("azure: the stored sign-in no longer works; Azure stays unconfigured until the owner connects it");
  });

  it("should relay nothing when only a requested sign-in may be relayed and the owner has asked for none", async () => {
    // Act
    const result = await azureLogin({ api: api(), env: pod.env(), mode: "requested" });

    // Assert
    expect(result).toBe("not-connected");
    expect(virtual().prompts).toHaveLength(0);
  });

  it("should relay the device code and sign in when the owner has asked for an Azure sign-in", async () => {
    // Arrange
    virtual().signInRequests.add("azure");

    // Act
    const { result } = await captureStderr(() => azureLogin({ api: api(), env: pod.env(), mode: "requested" }));

    // Assert
    expect(result).toBe("signed-in");
    expect(virtual().prompts).toHaveLength(1);
    expect(virtual().completes).toEqual([{ kind: "azure", account_oid: OWNER.oid, account_label: "olive@hmcts.net" }]);
    expect(virtual().signInRequests.has("azure")).toBe(false);
  });

  it("should tell the hub and stay unconnected when a requested sign-in is not completed", async () => {
    // Arrange
    virtual().signInRequests.add("azure");

    // Act
    const { result, stderr } = await captureStderr(() => azureLogin({ api: api(), env: pod.env({ FAKE_AZ_LOGIN_RC: "1" }), mode: "requested" }));

    // Assert
    expect(result).toBe("not-connected");
    expect(virtual().loginFailures).toEqual([{ kind: "azure", state: "failed", detail: "azure: the sign-in was not completed (az login exited 1)" }]);
    expect(virtual().completes).toHaveLength(0);
    expect(stderr).toContain("Azure stays unconfigured");
  });

  it("should say so and still stay unconnected when the hub cannot be told the requested sign-in failed", async () => {
    // Arrange
    const real = api();
    const failing: Api = { ...real, loginFailed: async () => Promise.reject(new ApiError(500, { error: "down" }, "POST", "/x")) };
    virtual().signInRequests.add("azure");

    // Act
    const { result, stderr } = await captureStderr(() => azureLogin({ api: failing, env: pod.env({ FAKE_AZ_LOGIN_RC: "1" }), mode: "requested" }));

    // Assert
    expect(result).toBe("not-connected");
    expect(stderr).toContain("azure: could not tell agent-hub the sign-in was not completed");
  }, 30_000);

  it("should still throw when the default relay's az login fails", async () => {
    // Act
    const { error } = await captureStderrOfFailure(() => azureLogin({ api: api(), env: pod.env({ FAKE_AZ_LOGIN_RC: "1" }) }));

    // Assert
    expect((error as Error).message).toBe("az login exited 1");
    expect(virtual().loginFailures).toHaveLength(0);
  });

  it("should report a failed sign-in and stay unconnected when a requested code could not be relayed", async () => {
    // Arrange: the code reaches the hub, which then refuses the status that follows it.
    const real = api();
    const refusing: Api = { ...real, virtualStatus: async () => Promise.reject(new ApiError(400, { error: "no" }, "POST", "/x")) };
    virtual().signInRequests.add("azure");

    // Act
    const { result } = await captureStderr(() => azureLogin({ api: refusing, env: pod.env(), mode: "requested" }));

    // Assert
    expect(result).toBe("not-connected");
    expect(virtual().loginFailures[0]).toMatchObject({ kind: "azure", state: "failed" });
  }, 30_000);
});
