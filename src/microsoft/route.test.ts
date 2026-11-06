import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../agent-api/http.ts";

const mintMicrosoftToken = vi.hoisted(() => vi.fn());

vi.mock("../store/prisma.ts", () => ({ prisma: {} }));
vi.mock("../virtual-agents/route-params.ts", () => ({ requireStore: () => ({}) }));
vi.mock("./token.ts", () => ({ mintMicrosoftToken, refreshSettings: () => ({}) }));

const { microsoftTokenResponse, NOT_ON_GATEWAY } = await import("./route.ts");

const TOKEN = { access_token: "a-token", expires_at: "2026-12-01T10:00:00.000Z", permissions: ["Mail.Read"] };

afterEach(() => {
  vi.clearAllMocks();
});

describe("microsoftTokenResponse", () => {
  it("should mint the owner's token when they are on the gateway route", async () => {
    mintMicrosoftToken.mockResolvedValue(TOKEN);

    const response = await microsoftTokenResponse("an-oid", "pod", "gateway");

    expect(await response.json()).toEqual(TOKEN);
    expect(mintMicrosoftToken).toHaveBeenCalledWith({}, {}, expect.objectContaining({ ownerOid: "an-oid", via: "pod" }));
  });

  it("should refuse with 403, reading no connection, when the owner is on their own Claude licence", async () => {
    const refused = microsoftTokenResponse("an-oid", "cli", "own-licence");

    await expect(refused).rejects.toBeInstanceOf(HttpError);
    await expect(refused).rejects.toMatchObject({ status: 403, message: NOT_ON_GATEWAY });
    expect(mintMicrosoftToken).not.toHaveBeenCalled();
  });
});
