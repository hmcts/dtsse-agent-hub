import { describe, expect, it } from "vitest";
import { sealSession } from "../auth/session.ts";
import { DEV_PERSONA_COOKIE, devIdentity, isDevIdentity, viewerFrom } from "./identity.ts";

const SECRET = "a-session-secret-long-enough-to-seal-with";
const SIGNED_IN = { AUTH_DISABLED: undefined, SESSION_SECRET: SECRET };

function jar(values: Record<string, string>) {
  return (name: string) => values[name];
}

describe("devIdentity", () => {
  it("should be a fixed, labelled identity in the dev tenant when no persona is chosen", () => {
    expect(devIdentity()).toEqual({ oid: "dev-anonymous", tid: "dev", name: "Anonymous (sign-in disabled)", email: "anonymous@dev.invalid" });
  });

  it("should give a named persona its own identity when one is chosen", () => {
    expect(devIdentity("owner-2")).toEqual({ oid: "dev-owner-2", tid: "dev", name: "Dev owner-2 (sign-in disabled)", email: "owner-2@dev.invalid" });
  });

  it.each([
    "",
    "Owner",
    "has space",
    "x".repeat(33),
    "00000000-0000-0000-0000-00000000000"
  ])("should fall back to anonymous when the persona is %j", (persona) => {
    expect(devIdentity(persona).oid).toBe("dev-anonymous");
  });

  it("should never produce an oid shaped like an Entra object id", () => {
    expect(devIdentity("a").oid.startsWith("dev-")).toBe(true);
  });
});

describe("isDevIdentity", () => {
  it("should recognise the dev tenant and nothing else", () => {
    expect(isDevIdentity({ tid: "dev" })).toBe(true);
    expect(isDevIdentity({ tid: "531ff96d-0ae9-462a-8d2d-bec7c0b42082" })).toBe(false);
  });
});

describe("viewerFrom", () => {
  it("should be the anonymous dev identity when sign-in is disabled and there is no persona", async () => {
    expect(await viewerFrom(jar({}), { AUTH_DISABLED: "true" })).toEqual({ ...devIdentity(), modelRoute: "gateway" });
  });

  it.each([
    ["second", "gateway"],
    ["own-licence", "own-licence"],
    ["own-licence-2", "own-licence"],
    ["own-licenced", "gateway"]
  ])("should put the persona %s on the %s route when sign-in is disabled", async (persona, route) => {
    expect((await viewerFrom(jar({ [DEV_PERSONA_COOKIE]: persona }), { AUTH_DISABLED: "true" }))?.modelRoute).toBe(route);
  });

  it("should take the persona cookie when sign-in is disabled", async () => {
    expect((await viewerFrom(jar({ [DEV_PERSONA_COOKIE]: "second" }), { AUTH_DISABLED: "true" }))?.oid).toBe("dev-second");
  });

  it("should be the configured person in the Entra tenant when sign-in is disabled and AUTH_DEV_USER is set", async () => {
    const env = { AUTH_DISABLED: "true", AUTH_DEV_USER: "real-oid|Real Person|real@example.com", ENTRA_TENANT_ID: "real-tid" };

    expect(await viewerFrom(jar({ [DEV_PERSONA_COOKIE]: "second" }), env)).toEqual({
      oid: "real-oid",
      tid: "real-tid",
      name: "Real Person",
      email: "real@example.com",
      modelRoute: "gateway"
    });
  });

  it("should put the configured person in the dev tenant when AUTH_DEV_USER is set without ENTRA_TENANT_ID", async () => {
    expect((await viewerFrom(jar({}), { AUTH_DISABLED: "true", AUTH_DEV_USER: "real-oid|Real Person" }))?.tid).toBe("dev");
  });

  it("should refuse to serve anyone when AUTH_DEV_USER is malformed", async () => {
    await expect(viewerFrom(jar({}), { AUTH_DISABLED: "true", AUTH_DEV_USER: "only-an-oid" })).rejects.toThrow("AUTH_DEV_USER");
  });

  it("should ignore AUTH_DEV_USER when sign-in is required", async () => {
    expect(await viewerFrom(jar({}), { ...SIGNED_IN, AUTH_DEV_USER: "real-oid|Real Person" })).toBeUndefined();
  });

  it("should ignore the persona cookie when sign-in is required", async () => {
    expect(await viewerFrom(jar({ [DEV_PERSONA_COOKIE]: "second" }), SIGNED_IN)).toBeUndefined();
  });

  it("should be the session's person on their own licence when the cookie opens without the gateway role", async () => {
    const identity = { oid: "real-oid", tid: "real-tid", name: "Real Person", email: "real@example.com" };
    const cookie = await sealSession({ ...identity, aiGateway: false }, SECRET);

    expect(await viewerFrom(jar({ ah_session: cookie }), SIGNED_IN)).toEqual({ ...identity, modelRoute: "own-licence" });
  });

  it("should put the session's person on the gateway route when the cookie carries the gateway role", async () => {
    const cookie = await sealSession({ oid: "real-oid", tid: "real-tid", name: "Real Person", aiGateway: true }, SECRET);

    expect((await viewerFrom(jar({ ah_session: cookie }), SIGNED_IN))?.modelRoute).toBe("gateway");
  });

  it("should be nobody when the session cookie does not open", async () => {
    expect(await viewerFrom(jar({ ah_session: "forged" }), SIGNED_IN)).toBeUndefined();
  });

  it("should be nobody when no session secret is configured", async () => {
    expect(await viewerFrom(jar({}), {})).toBeUndefined();
  });
});
