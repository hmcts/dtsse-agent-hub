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
    expect(await viewerFrom(jar({}), { AUTH_DISABLED: "true" })).toEqual(devIdentity());
  });

  it("should take the persona cookie when sign-in is disabled", async () => {
    expect((await viewerFrom(jar({ [DEV_PERSONA_COOKIE]: "second" }), { AUTH_DISABLED: "true" }))?.oid).toBe("dev-second");
  });

  it("should ignore the persona cookie when sign-in is required", async () => {
    expect(await viewerFrom(jar({ [DEV_PERSONA_COOKIE]: "second" }), SIGNED_IN)).toBeUndefined();
  });

  it("should be the session's person when the cookie opens", async () => {
    const session = { oid: "real-oid", tid: "real-tid", name: "Real Person", email: "real@example.com" };
    const cookie = await sealSession(session, SECRET);

    expect(await viewerFrom(jar({ ah_session: cookie }), SIGNED_IN)).toEqual(session);
  });

  it("should be nobody when the session cookie does not open", async () => {
    expect(await viewerFrom(jar({ ah_session: "forged" }), SIGNED_IN)).toBeUndefined();
  });

  it("should be nobody when no session secret is configured", async () => {
    expect(await viewerFrom(jar({}), {})).toBeUndefined();
  });
});
