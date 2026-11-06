import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginSignIn, sealSignIn } from "../../../auth/entra.ts";
import { SESSION_COOKIE, sealSession } from "../../../auth/session.ts";

const completeMicrosoftConnect = vi.hoisted(() => vi.fn());
const putCredential = vi.hoisted(() => vi.fn());

vi.mock("@/auth/entra", async () => ({ ...(await import("../../../auth/entra.ts")), completeMicrosoftConnect }));
vi.mock("@/store/prisma", () => ({ prisma: {} }));
vi.mock("@/users/store", () => ({ upsertUser: vi.fn() }));
vi.mock("@/credentials/backend", () => ({ credentialBackend: () => ({ available: true, store: {} }) }));
vi.mock("@/credentials/store", () => ({ putCredential }));

const { GET } = await import("./route.ts");

const HUB = "https://agent-hub.example";
const SECRET = "a-session-secret-long-enough-to-be-plausible";
const ENV = {
  ENTRA_TENANT_ID: "a-tenant",
  ENTRA_CLIENT_ID: "a-client",
  ENTRA_CLIENT_SECRET: "a-secret",
  ENTRA_REDIRECT_URI: `${HUB}/auth/callback`,
  SESSION_SECRET: SECRET
};
const SETTINGS = "/assistant?settings=connections";

async function callback(query: string, aiGateway = true): Promise<Response> {
  const signIn = await sealSignIn(beginSignIn(SETTINGS, "microsoft"), SECRET);
  const session = await sealSession({ oid: "an-oid", tid: "a-tenant", name: "A Person", aiGateway }, SECRET);
  return await GET(new NextRequest(`${HUB}/auth/callback?${query}`, { headers: { cookie: `ah_sign_in=${signIn}; ${SESSION_COOKIE}=${session}` } }));
}

const clearsSignIn = (response: Response) => /ah_sign_in=;.*max-age=0/.test(response.headers.get("set-cookie") ?? "");

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) {
    vi.stubEnv(name, value);
  }
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  completeMicrosoftConnect.mockResolvedValue({ refreshToken: "a-refresh", account: "a.person@hmcts.net", scope: "Mail.Read" });
  putCredential.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("the callback completing a Microsoft 365 connect", () => {
  it("should keep the connection and go back to settings when Entra answers with a code", async () => {
    const response = await callback("code=a-code&state=a-state");

    expect(response.headers.get("location")).toBe(SETTINGS);
    expect(putCredential).toHaveBeenCalledOnce();
    expect(clearsSignIn(response)).toBe(true);
  });

  it("should say Microsoft 365 was not connected, in settings and not at a sign-in, when the person cancels at Microsoft", async () => {
    const response = await callback("error=access_denied&error_description=cancelled&state=a-state");

    expect(response.headers.get("location")).toBe(`${SETTINGS}&microsoft=cancelled`);
    expect(completeMicrosoftConnect).not.toHaveBeenCalled();
    expect(clearsSignIn(response)).toBe(true);
  });

  it("should say the connect failed when Entra answers with another error", async () => {
    expect((await callback("error=server_error&state=a-state")).headers.get("location")).toBe(`${SETTINGS}&microsoft=failed`);
  });

  it("should go back to settings saying it failed, with the sign-in cleared, when the connection cannot be kept", async () => {
    putCredential.mockRejectedValue(new Error("Key Vault is unavailable"));
    const response = await callback("code=a-code&state=a-state");

    expect(response.headers.get("location")).toBe(`${SETTINGS}&microsoft=failed`);
    expect(clearsSignIn(response)).toBe(true);
  });

  it("should go back to settings saying it failed when the exchange is refused", async () => {
    completeMicrosoftConnect.mockRejectedValue(new Error("the Microsoft account signed in to is not the one signed in to the hub"));

    expect((await callback("code=a-code&state=a-state")).headers.get("location")).toBe(`${SETTINGS}&microsoft=failed`);
    expect(putCredential).not.toHaveBeenCalled();
  });

  it("should go back to settings saying it is unavailable, exchanging nothing and keeping nothing, when the person is not an AI Gateway user", async () => {
    const response = await callback("code=a-code&state=a-state", false);

    expect(response.headers.get("location")).toBe(`${SETTINGS}&microsoft=unavailable`);
    expect(completeMicrosoftConnect).not.toHaveBeenCalled();
    expect(putCredential).not.toHaveBeenCalled();
    expect(clearsSignIn(response)).toBe(true);
  });
});
