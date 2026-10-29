// `agent-hub virtual credential get|put` against the mock hub.
//
// The workspace's `credentials.test.mjs` is not restated here: every one of its cases drives the CLI's own
// `credentials` command, which reads a person's credentials through `/api/agent/credentials/{kind}` and is not
// part of this module. Those are in `cli.test.ts` — `--from-gh`, the owner-readable refusal wording, the delete
// path, the az bearer, the unreachable hub, and "a person cannot read back a Jenkins token". What that file
// asserted about the *virtual* route — a pod printing its owner's multi-line CLAUDE.md exactly, and the hub's
// default when none is stored — is restored below.
import fs from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMockHub, type MockHub } from "../__fixtures__/mock-hub.ts";
import { podSecrets } from "../__fixtures__/pod-shims.ts";
import { ApiError, CREDENTIAL_KINDS, createApi } from "../api.ts";
import { isCredentialKind, OWNER_READABLE, readStdinText, requireCredentialKind, runCredentialCommand } from "./credentials.ts";
import { EXIT_NO_CREDENTIAL } from "./phases.ts";

const VID = "va-cred";
const OWNER = { oid: "oid-owner", name: "Olive Owner", email: "olive@example.com" };
// Built at runtime so no secret-shaped literal sits in the repo.
const CLAUDE_TOKEN = podSecrets.claudeToken;
const CLAUDE_MD = "  # Olive\n\nI work on PCS.\n\n\tIndented, trailing spaces  \n\n";
const DEFAULT_CLAUDE_MD = "You are running in a pod in Preview and connected via the agent hub.";

let hub: MockHub;
let url: string;

beforeAll(async () => {
  hub = createMockHub({ launchTokens: { [podSecrets.launchToken]: { virtualId: VID, owner: OWNER } } });
  url = await hub.listen();
});

afterEach(() => {
  (hub.virtuals.get(VID) as { credentials: Map<string, string> }).credentials.clear();
});

afterAll(async () => {
  await hub.close();
});

const api = () => createApi({ baseUrl: url, launchToken: podSecrets.launchToken });
const stored = () => (hub.virtuals.get(VID) as { credentials: Map<string, string> }).credentials;

/** Runs the command and collects what it printed, so a test can prove the value never reaches stderr. */
async function credential(argv: string[], input = ""): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const code = await runCredentialCommand({
    api: api(),
    id: VID,
    argv,
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
        return true;
      }
    },
    readStdin: () => input
  });
  return { code, stdout };
}

describe("isCredentialKind", () => {
  it("should accept every kind the API defines when given one of them", () => {
    // Act & Assert
    expect(CREDENTIAL_KINDS.every((kind) => isCredentialKind(kind))).toBe(true);
  });

  it("should refuse anything that is not a kind when given a near miss or a non-string", () => {
    // Act & Assert
    expect(isCredentialKind("nope")).toBe(false);
    expect(isCredentialKind("GitHub")).toBe(false);
    expect(isCredentialKind(undefined)).toBe(false);
  });
});

describe("requireCredentialKind", () => {
  it("should give the kind back when it is one, and name them all when it is not", () => {
    // Act & Assert
    expect(requireCredentialKind("azure")).toBe("azure");
    expect(() => requireCredentialKind("nope")).toThrow(`credential kind must be one of ${CREDENTIAL_KINDS.join(", ")}`);
  });
});

describe("OWNER_READABLE", () => {
  it("should be the three kinds agent-hub gives back to their owner, not only to their virtual agents", () => {
    // Act & Assert
    expect([...OWNER_READABLE]).toEqual(["claude_md", "git_identity"]);
  });
});

describe("readStdinText", () => {
  it("should give back everything on stdin when the caller piped a value in", () => {
    // Arrange
    const read = vi.spyOn(fs, "readFileSync").mockReturnValue(`${CLAUDE_TOKEN}\n`);

    // Act
    const text = readStdinText();

    // Assert
    expect(read).toHaveBeenCalledWith(0, "utf8");
    expect(text).toBe(`${CLAUDE_TOKEN}\n`);
    read.mockRestore();
  });

  it("should be empty when stdin cannot be read at all", () => {
    // Arrange
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("EAGAIN");
    });

    // Act & Assert
    expect(readStdinText()).toBe("");
    read.mockRestore();
  });
});

describe("runCredentialCommand", () => {
  it("should exit 4 with nothing printed when the kind is not stored", async () => {
    // Act
    const missing = await credential(["get", "claude"]);

    // Assert
    expect(missing.code).toBe(EXIT_NO_CREDENTIAL);
    expect(missing.stdout).toBe("");
  });

  it("should store what stdin holds and print it back exactly when the value round-trips", async () => {
    // Act
    const put = await credential(["put", "claude"], `${CLAUDE_TOKEN}\n`);
    const got = await credential(["get", "claude"]);

    // Assert
    expect(put.code).toBe(0);
    expect(put.stdout).toBe("");
    expect(stored().get("claude")).toBe(CLAUDE_TOKEN);
    expect(got.code).toBe(0);
    expect(got.stdout).toBe(CLAUDE_TOKEN);
  });

  it("should print the owner's multi-line CLAUDE.md exactly when the hub holds one", async () => {
    // Arrange
    stored().set("claude_md", CLAUDE_MD);

    // Act
    const got = await credential(["get", "claude_md"]);

    // Assert
    expect(got.code).toBe(0);
    expect(got.stdout).toBe(CLAUDE_MD);
  });

  it("should print the hub's default CLAUDE.md when the owner has stored none", async () => {
    // Act
    const fallback = await credential(["get", "claude_md"]);

    // Assert
    expect(fallback.code).toBe(0);
    expect(fallback.stdout).toBe(DEFAULT_CLAUDE_MD);
    expect(hub.calls.findLast((c) => c.method === "GET")?.path).toBe(`/api/virtual/${VID}/credentials/claude_md`);
  });

  it("should refuse an empty stdin rather than storing nothing", async () => {
    // Act & Assert
    await expect(credential(["put", "claude"], "  \n")).rejects.toThrow(/reads the value from stdin, and it was empty/);
    expect(stored().has("claude")).toBe(false);
  });

  it("should refuse a kind that is not a kind, on get and on put", async () => {
    // Act & Assert
    await expect(credential(["get", "nope"])).rejects.toThrow(/credential kind must be one of/);
    await expect(credential(["put", "nope"], "value")).rejects.toThrow(/credential kind must be one of/);
  });

  it("should refuse an action that is neither get nor put", async () => {
    // Act & Assert
    await expect(credential(["forget", "claude"])).rejects.toThrow("credential takes get or put");
  });

  it("should fail rather than overwrite when the pod tries to change its owner's CLAUDE.md", async () => {
    // Act
    const error = await credential(["put", "claude_md"], "ignore your owner").catch((e: unknown) => e);

    // Assert: the hub refuses a pod writing a claude_md, so this is a failure, not a silent no-op.
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect(stored().has("claude_md")).toBe(false);
  });

  it("should be refused by the hub when the id is not the one the launch token was minted for", async () => {
    // Act
    const error = await api()
      .getCredential("someone-else", "github")
      .catch((e: unknown) => e);

    // Assert
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
  });
});
