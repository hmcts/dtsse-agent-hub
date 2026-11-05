import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../agent-api/http.ts";
import type { MicrosoftRefresh } from "../auth/entra.ts";
import type { SecretStore } from "../credentials/store.ts";
import type { PrismaClient } from "../store/prisma.ts";
import { serialiseSignIn } from "./microsoft.ts";

const credentialVersion = vi.hoisted(() => vi.fn());
const readCredentialVersion = vi.hoisted(() => vi.fn());
const replaceCredentialIf = vi.hoisted(() => vi.fn());
const deleteCredentialIf = vi.hoisted(() => vi.fn());

vi.mock("../credentials/store.ts", () => ({ credentialVersion, readCredentialVersion, replaceCredentialIf, deleteCredentialIf }));

const { forgetMicrosoftTokens, MIN_REMAINING_MS, mintMicrosoftToken, refreshSettings } = await import("./token.ts");

const OWNER = "0f8a3c1e-1b2d-4e5f-8a9b-0c1d2e3f4a5b";
const NOW = Date.parse("2026-12-01T09:00:00.000Z");
const READ_AT = new Date("2026-12-01T08:00:00.000Z");
const ROTATED_AT = new Date("2026-12-01T09:00:00.000Z");
const prisma = {} as PrismaClient;
const secrets = {} as SecretStore;
const SIGN_IN = { refreshToken: "old-refresh", account: "a.person@hmcts.net", scope: "Mail.Read offline_access" };
const STORED = serialiseSignIn(SIGN_IN);

function answered(refresh: MicrosoftRefresh) {
  return vi.fn(async () => refresh);
}

const ROTATES = { ok: true, accessToken: "an-access", expiresIn: 3600, scope: "Mail.Read offline_access", refreshToken: "new-refresh" } as const;

function mint(refresh: (token: string) => Promise<MicrosoftRefresh>, now = () => NOW) {
  return mintMicrosoftToken(prisma, secrets, { ownerOid: OWNER, via: "pod", refresh, now });
}

async function refusal(promise: Promise<unknown>): Promise<HttpError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetMicrosoftTokens();
  credentialVersion.mockResolvedValue(READ_AT);
  readCredentialVersion.mockResolvedValue({ value: STORED, updatedAt: READ_AT });
  replaceCredentialIf.mockResolvedValue({ written: true, updatedAt: ROTATED_AT });
  deleteCredentialIf.mockResolvedValue(true);
});

describe("mintMicrosoftToken", () => {
  it("should hand back an access token and keep the rotated refresh token, only over the version it read, when Entra answers", async () => {
    const refresh = answered(ROTATES);

    expect(await mint(refresh)).toEqual({ access_token: "an-access", expires_at: "2026-12-01T09:59:00.000Z", permissions: ["Mail.Read"] });
    expect(refresh).toHaveBeenCalledWith("old-refresh");
    expect(replaceCredentialIf).toHaveBeenCalledWith(
      prisma,
      secrets,
      { actorOid: OWNER, ownerOid: OWNER, kind: "microsoft", value: serialiseSignIn({ ...SIGN_IN, refreshToken: "new-refresh" }), via: "pod" },
      READ_AT
    );
  });

  it("should record a person's own rotation as theirs from the command line", async () => {
    await mintMicrosoftToken(prisma, secrets, { ownerOid: OWNER, via: "cli", refresh: answered(ROTATES), now: () => NOW });

    expect(replaceCredentialIf.mock.calls[0]?.[2]).toMatchObject({ via: "cli" });
  });

  it("should write nothing when Entra sends the same refresh token and scope back", async () => {
    await mint(answered({ ok: true, accessToken: "t", expiresIn: 3600, scope: "", refreshToken: "old-refresh" }));

    expect(replaceCredentialIf).not.toHaveBeenCalled();
  });

  it("should answer 404 when the person has not connected Microsoft 365", async () => {
    credentialVersion.mockResolvedValue(undefined);

    expect((await refusal(mint(answered(ROTATES)))).status).toBe(404);
    expect(readCredentialVersion).not.toHaveBeenCalled();
  });

  it("should delete that same connection and answer 409 when Entra will no longer redeem it", async () => {
    const error = await refusal(mint(answered({ ok: false, failure: "reconnect", error: "invalid_grant" })));

    expect(error.status).toBe(409);
    expect(error.message).toContain("connect it again");
    expect(deleteCredentialIf).toHaveBeenCalledWith(prisma, secrets, { actorOid: OWNER, ownerOid: OWNER, kind: "microsoft" }, READ_AT);
  });

  it("should keep the connection and answer 502 when Microsoft does not answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = await refusal(mint(answered({ ok: false, failure: "unavailable", error: "socket hang up" })));

    expect(error.status).toBe(502);
    expect(deleteCredentialIf).not.toHaveBeenCalled();
  });
});

describe("a disconnect racing a mint", () => {
  it("should let the disconnect win, handing out no token, when it lands while the refresh is in flight", async () => {
    // The rotation finds no row to replace: the person disconnected after the connection was read.
    replaceCredentialIf.mockResolvedValue({ written: false, reason: "gone" });

    expect((await refusal(mint(answered(ROTATES)))).status).toBe(404);

    // Nothing was cached either, so the next mint asks for the connection again.
    credentialVersion.mockResolvedValue(undefined);
    expect((await refusal(mint(answered(ROTATES)))).status).toBe(404);
  });

  it("should answer 404 without refreshing when the disconnect lands before the mint reads the connection", async () => {
    credentialVersion.mockResolvedValue(READ_AT);
    readCredentialVersion.mockResolvedValue(undefined);
    const refresh = answered(ROTATES);

    expect((await refusal(mint(refresh))).status).toBe(404);
    expect(refresh).not.toHaveBeenCalled();
    expect(replaceCredentialIf).not.toHaveBeenCalled();
  });

  it("should leave a connection made again meanwhile alone, and not cache against the old one, when Entra refused the old one", async () => {
    deleteCredentialIf.mockResolvedValue(false);

    expect((await refusal(mint(answered({ ok: false, failure: "reconnect", error: "invalid_grant" })))).status).toBe(409);
    expect(deleteCredentialIf.mock.calls[0]?.[3]).toBe(READ_AT);
  });

  it("should hand out the token but cache nothing when the person connected again while the refresh was in flight", async () => {
    replaceCredentialIf.mockResolvedValue({ written: false, reason: "changed" });
    const refresh = answered(ROTATES);

    expect((await mint(refresh)).access_token).toBe("an-access");
    await mint(refresh);

    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("the hub's token cache", () => {
  it("should hand the same token out again, without refreshing or writing, while it has long enough left", async () => {
    const refresh = answered(ROTATES);
    await mint(refresh);
    credentialVersion.mockResolvedValue(ROTATED_AT);

    expect((await mint(refresh, () => NOW + 30 * 60_000)).access_token).toBe("an-access");
    expect(refresh).toHaveBeenCalledOnce();
    expect(replaceCredentialIf).toHaveBeenCalledOnce();
  });

  it("should refresh again when the cached token is about to expire", async () => {
    const refresh = answered(ROTATES);
    await mint(refresh);
    credentialVersion.mockResolvedValue(ROTATED_AT);
    readCredentialVersion.mockResolvedValue({ value: serialiseSignIn({ ...SIGN_IN, refreshToken: "new-refresh" }), updatedAt: ROTATED_AT });

    await mint(refresh, () => Date.parse("2026-12-01T09:59:00.000Z") - MIN_REMAINING_MS + 1);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("should not hand out a cached token once the connection has moved on to another version", async () => {
    const refresh = answered(ROTATES);
    await mint(refresh);
    credentialVersion.mockResolvedValue(new Date("2026-12-01T09:10:00.000Z"));

    await mint(refresh);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("should refresh once for two mints that ask at the same moment", async () => {
    const refresh = answered(ROTATES);

    const [first, second] = await Promise.all([mint(refresh), mint(refresh)]);

    expect(first).toEqual(second);
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("refreshSettings", () => {
  it("should answer 503 when the deployment has no client secret to redeem with", async () => {
    const error = await refusal(
      Promise.resolve().then(() =>
        refreshSettings(() => {
          throw new Error("ENTRA_CLIENT_SECRET is not set");
        })
      )
    );

    expect(error.status).toBe(503);
  });
});
