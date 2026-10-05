import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../agent-api/http.ts";
import type { SecretStore } from "../credentials/store.ts";
import { pathKind, requireSessionSecret, requireStore } from "./route-params.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

const STORE: SecretStore = { acceptsDevIdentities: true, put: async () => undefined, get: async () => undefined, remove: async () => undefined };

describe("pathKind", () => {
  it.each(["github", "azure", "claude", "bedrock"])("should accept %s when it is a kind of credential", (kind) => {
    expect(pathKind(kind)).toBe(kind);
  });

  it("should answer 404 when the kind is unknown", () => {
    expect(() => pathKind("ssh")).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe("requireStore", () => {
  it("should hand back the store when the deployment has one", () => {
    expect(requireStore({} as never, { available: true, store: STORE })).toBe(STORE);
  });

  it("should answer 503 with the reason when it has none", () => {
    expect(() => requireStore({} as never, { available: false, reason: "no vault" })).toThrow(new HttpError(503, "no vault"));
  });
});

describe("requireSessionSecret", () => {
  it("should hand back the secret when one is set", () => {
    vi.stubEnv("SESSION_SECRET", "s3cret");

    expect(requireSessionSecret()).toBe("s3cret");
  });

  it("should answer 503 when none is set", () => {
    vi.stubEnv("SESSION_SECRET", "");

    expect(() => requireSessionSecret()).toThrow(expect.objectContaining({ status: 503 }));
  });
});
