import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../agent-api/http.ts";
import type { MicrosoftRefresh } from "../auth/entra.ts";
import type { SecretStore } from "../credentials/store.ts";
import type { PrismaClient } from "../store/prisma.ts";
import { serialiseSignIn } from "./microsoft.ts";

const readCredential = vi.hoisted(() => vi.fn());
const putCredential = vi.hoisted(() => vi.fn());
const deleteCredential = vi.hoisted(() => vi.fn());

vi.mock("../credentials/store.ts", () => ({ readCredential, putCredential, deleteCredential }));

const { mintMicrosoftToken, refreshSettings } = await import("./token.ts");

const OWNER = "0f8a3c1e-1b2d-4e5f-8a9b-0c1d2e3f4a5b";
const NOW = Date.parse("2026-12-01T09:00:00.000Z");
const prisma = {} as PrismaClient;
const store = {} as SecretStore;
const STORED = serialiseSignIn({ refreshToken: "old-refresh", account: "a.person@hmcts.net", scope: "Mail.Read offline_access" });

function answered(refresh: MicrosoftRefresh) {
  return vi.fn(async () => refresh);
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
  readCredential.mockResolvedValue(STORED);
});

describe("mintMicrosoftToken", () => {
  it("should hand back an access token and keep the rotated refresh token when Entra answers", async () => {
    const refresh = answered({ ok: true, accessToken: "an-access", expiresIn: 3600, scope: "Mail.Read offline_access", refreshToken: "new-refresh" });

    expect(await mintMicrosoftToken(prisma, store, OWNER, refresh, () => NOW)).toEqual({
      access_token: "an-access",
      expires_at: "2026-12-01T09:59:00.000Z",
      permissions: ["Mail.Read"]
    });
    expect(refresh).toHaveBeenCalledWith("old-refresh");
    expect(putCredential).toHaveBeenCalledWith(prisma, store, {
      actorOid: OWNER,
      ownerOid: OWNER,
      kind: "microsoft",
      value: serialiseSignIn({ refreshToken: "new-refresh", account: "a.person@hmcts.net", scope: "Mail.Read offline_access" }),
      via: "web"
    });
  });

  it("should write nothing when Entra sends the same refresh token and scope back", async () => {
    await mintMicrosoftToken(prisma, store, OWNER, answered({ ok: true, accessToken: "t", expiresIn: 3600, scope: "", refreshToken: "old-refresh" }));

    expect(putCredential).not.toHaveBeenCalled();
  });

  it("should answer 404 when the person has not connected Microsoft 365", async () => {
    readCredential.mockResolvedValue(undefined);

    expect((await refusal(mintMicrosoftToken(prisma, store, OWNER, answered({ ok: false, failure: "unavailable", error: "" })))).status).toBe(404);
  });

  it("should delete the connection and answer 409 when Entra will no longer redeem it", async () => {
    const error = await refusal(mintMicrosoftToken(prisma, store, OWNER, answered({ ok: false, failure: "reconnect", error: "invalid_grant" })));

    expect(error.status).toBe(409);
    expect(error.message).toContain("connect it again");
    expect(deleteCredential).toHaveBeenCalledWith(prisma, store, { actorOid: OWNER, ownerOid: OWNER, kind: "microsoft" });
  });

  it("should keep the connection and answer 502 when Microsoft does not answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = await refusal(mintMicrosoftToken(prisma, store, OWNER, answered({ ok: false, failure: "unavailable", error: "socket hang up" })));

    expect(error.status).toBe(502);
    expect(deleteCredential).not.toHaveBeenCalled();
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
