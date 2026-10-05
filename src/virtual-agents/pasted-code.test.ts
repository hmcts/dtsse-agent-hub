import { describe, expect, it } from "vitest";
import { localKey } from "../credentials/local.ts";
import { openPastedCode, pastedCodeKey, sealPastedCode } from "./pasted-code.ts";

const SECRET = "a-test-session-secret-long-enough-to-be-plausible";
const AGENT = "0f8a6a1e-0000-4000-8000-000000000001";

describe("sealPastedCode and openPastedCode", () => {
  it("should open a sealed code when the secret, the agent and the kind are the same", () => {
    const sealed = sealPastedCode(SECRET, AGENT, "claude", "code#123");

    expect(Buffer.from(sealed.ciphertext).toString("utf8")).not.toContain("code#123");
    expect(openPastedCode(SECRET, AGENT, "claude", sealed)).toBe("code#123");
  });

  it.each([
    ["another secret", "another-secret-of-a-plausible-length-too", AGENT, "claude"],
    ["another agent", SECRET, "0f8a6a1e-0000-4000-8000-000000000002", "claude"],
    ["another kind", SECRET, AGENT, "github"]
  ])("should refuse to open a code when it is opened with %s", (_label, secret, agent, kind) => {
    const sealed = sealPastedCode(SECRET, AGENT, "claude", "code#123");

    expect(() => openPastedCode(secret, agent, kind, sealed)).toThrow();
  });

  it("should derive a key of its own when the secret is the one the credential store uses", () => {
    expect(pastedCodeKey(SECRET).equals(localKey(SECRET))).toBe(false);
  });
});
