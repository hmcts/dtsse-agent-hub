import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as credentialRoute from "../../src/app/api/agent/credentials/[kind]/route.ts";
import { credentialBackend } from "../../src/credentials/backend.ts";
import { DEFAULT_CLAUDE_MD } from "../../src/credentials/claude-md.ts";
import { credentialStatus, deleteCredential, putCredential, readCredential, type SecretStore } from "../../src/credentials/store.ts";
import { devIdentity } from "../../src/viewer/identity.ts";
import { connect, insertUser, type Person, person, prisma, resetDatabase } from "./database.ts";
import { call, jsonOf } from "./routes.ts";

vi.mock("next/headers", async () => {
  const { jar } = await import("./web-session.ts");
  return { cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined) }) };
});
vi.mock("next/cache", async () => {
  const { revalidated } = await import("./web-session.ts");
  return { revalidatePath: (path: string) => void revalidated.push(path) };
});

const { actAs, revalidated } = await import("./web-session.ts");
const { removeCredential, resetClaudeMd, saveClaudeMd, saveCredential } = await import("../../src/app/_actions/credentials.ts");
const { claudeMdSettings, credentialSettings } = await import("../../src/web/data.ts");

const { GET, PUT, DELETE } = credentialRoute;

const ALICE = person("alice");
const BOB = person("bob");

const GITHUB = `ghp_${"A1b2".repeat(9)}`;
const GITHUB_AGAIN = `ghp_${"Z9y8".repeat(9)}`;
const CLAUDE = `sk-ant-oat01-${"Qw_-".repeat(12)}`;
const BEDROCK = `ABSK${"QmVkcm9ja0FQSUtleS1leGFtcGxl".repeat(4)}`;
const JENKINS = "11a2b3c4d5e6f708192a3b4c5d6e7f8091";
const TENANT = "531ff96d-0ae9-462a-8d2d-bec7c0b42082";

function azureCacheFor(oid: string): string {
  return gzipSync(
    Buffer.from(
      JSON.stringify({
        Account: { a: { username: "alice@example.com", home_account_id: `${oid}.${TENANT}` } },
        RefreshToken: { r: { secret: "refresh-secret" } }
      })
    )
  ).toString("base64");
}

const AZURE = azureCacheFor(ALICE.oid);

function put(as: Person, kind: string, body: unknown): Promise<Response> {
  return call(PUT, { as, path: `/api/agent/credentials/${kind}`, method: "PUT", params: { kind }, body });
}

function read(as: Person, kind: string): Promise<Response> {
  return call(GET, { as, path: `/api/agent/credentials/${kind}`, params: { kind } });
}

function remove(as: Person, kind: string): Promise<Response> {
  return call(DELETE, { as, path: `/api/agent/credentials/${kind}`, method: "DELETE", params: { kind } });
}

function localStore(): SecretStore {
  const backend = credentialBackend(prisma);
  if (!backend.available) {
    throw new Error(backend.reason);
  }
  return backend.store;
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    data.set(key, value);
  }
  return data;
}

/** Every column of every row the hub keeps about credentials, as text, so a test can say a value is nowhere in it. */
async function everythingStored(): Promise<string> {
  const rows = await prisma.$queryRaw<unknown[]>`
    SELECT row_to_json(c)::text AS row FROM credential c
    UNION ALL
    SELECT row_to_json(d)::text FROM (SELECT secret_name, encode(ciphertext, 'escape') AS ciphertext, updated_at FROM dev_credential_value) d
  `;
  return JSON.stringify(rows);
}

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", "a-test-session-secret-long-enough-to-be-plausible");
  vi.stubEnv("ENTRA_TENANT_ID", TENANT);
  await resetDatabase();
  revalidated.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("PUT /api/agent/credentials/{kind}", () => {
  it("should store the caller's credential and its metadata when the value is valid", async () => {
    const response = await put(ALICE, "github", { value: GITHUB });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    const row = await prisma.credential.findUniqueOrThrow({ where: { ownerOid_kind: { ownerOid: ALICE.oid, kind: "github" } } });
    expect(row).toMatchObject({ secretName: "u-dev-alice-github", updatedVia: "cli", accountLabel: null });
    expect(await readCredential(prisma, localStore(), ALICE.oid, "github")).toBe(GITHUB);
  });

  it("should keep the value out of every column the hub stores when it saves one", async () => {
    await put(ALICE, "github", { value: GITHUB });
    await put(ALICE, "azure", { value: AZURE });

    const stored = await everythingStored();
    expect(stored).toContain("u-dev-alice-github");
    expect(stored).not.toContain(GITHUB);
    expect(stored).not.toContain(AZURE);
    expect(stored).not.toContain("refresh-secret");
  });

  it("should label an Azure token cache with its account when it is saved", async () => {
    expect((await put(ALICE, "azure", { value: AZURE })).status).toBe(204);

    expect((await credentialStatus(prisma, ALICE.oid)).find((status) => status.kind === "azure")).toMatchObject({
      stored: true,
      accountLabel: "alice@example.com",
      updatedVia: "cli"
    });
  });

  it("should refuse an Azure token cache with 400 when it is signed in as someone else", async () => {
    const response = await put(ALICE, "azure", { value: azureCacheFor(BOB.oid) });

    expect(response.status).toBe(400);
    expect((await jsonOf<{ error: string }>(response)).error).toContain("someone other than you");
    expect(await prisma.credential.count()).toBe(0);
    expect(await prisma.devCredentialValue.count()).toBe(0);
  });

  it("should answer 503 for an Azure token cache when the hub's tenant is not configured", async () => {
    vi.stubEnv("ENTRA_TENANT_ID", "");

    expect((await put(ALICE, "azure", { value: AZURE })).status).toBe(503);
    expect(await prisma.credential.count()).toBe(0);
  });

  it("should replace the value and move the timestamp when the same kind is saved again", async () => {
    await put(ALICE, "github", { value: GITHUB });
    const first = await prisma.credential.findUniqueOrThrow({ where: { ownerOid_kind: { ownerOid: ALICE.oid, kind: "github" } } });

    expect((await put(ALICE, "github", { value: GITHUB_AGAIN })).status).toBe(204);

    const second = await prisma.credential.findUniqueOrThrow({ where: { ownerOid_kind: { ownerOid: ALICE.oid, kind: "github" } } });
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    expect(await readCredential(prisma, localStore(), ALICE.oid, "github")).toBe(GITHUB_AGAIN);
    expect(await prisma.devCredentialValue.count()).toBe(1);
  });

  it.each([
    ["a value of the wrong shape", "github", { value: "not-a-token" }, 400, "GitHub token"],
    ["a body without a value", "github", {}, 400, "value"],
    ["a value that is not a string", "claude", { value: 42 }, 400, "value"],
    ["an Azure value that is not a token cache", "azure", { value: "abcd" }, 400, "Azure token cache"],
    ["an unknown kind", "ssh", { value: GITHUB }, 404, "no such kind"]
  ])("should refuse %s without storing anything", async (_label, kind, body, status, error) => {
    const response = await put(ALICE, kind, body);

    expect(response.status).toBe(status);
    expect((await jsonOf<{ error: string }>(response)).error).toContain(error);
    expect(await prisma.credential.count()).toBe(0);
    expect(await prisma.devCredentialValue.count()).toBe(0);
  });

  it("should never echo the value back when it refuses one", async () => {
    const response = await put(ALICE, "claude", { value: `sk-ant-${"x".repeat(5)}` });

    expect(await response.text()).not.toContain("sk-ant-xxxxx");
  });

  it("should answer 503 and store nothing when the deployment's credentials store is unusable", async () => {
    vi.stubEnv("CREDENTIALS_VAULT_URL", "http://not-a-vault.example");

    const response = await put(ALICE, "github", { value: GITHUB });

    expect(response.status).toBe(503);
    expect(await prisma.credential.count()).toBe(0);
  });

  it("should refuse a development identity before touching the vault when the deployment has one", async () => {
    vi.stubEnv("CREDENTIALS_VAULT_URL", "https://dtsse-ah-creds-test.vault.azure.net/");

    const response = await put(ALICE, "github", { value: GITHUB });

    expect(response.status).toBe(403);
    expect((await jsonOf<{ error: string }>(response)).error).toContain("development identity");
    expect(await prisma.credential.count()).toBe(0);
  });

  it("should tell the owner's pods when a credential is saved, naming the kind and never the value", async () => {
    const listener = await connect();
    try {
      const payloads: string[] = [];
      listener.on("notification", (message) => payloads.push(message.payload ?? ""));
      await listener.query("LISTEN hub_events");

      await put(ALICE, "github", { value: GITHUB });
      await remove(ALICE, "github");

      await expect.poll(() => payloads.length).toBe(2);
      expect(payloads.map((payload) => JSON.parse(payload))).toEqual([
        { type: "credential", owner_oid: ALICE.oid, kind: "github" },
        { type: "credential", owner_oid: ALICE.oid, kind: "github" }
      ]);
      expect(payloads.join("")).not.toContain(GITHUB);
    } finally {
      await listener.end();
    }
  });
});

describe("DELETE /api/agent/credentials/{kind}", () => {
  it("should remove the value and the metadata when the caller has one stored", async () => {
    await put(ALICE, "github", { value: GITHUB });

    expect((await remove(ALICE, "github")).status).toBe(204);

    expect(await prisma.credential.count()).toBe(0);
    expect(await prisma.devCredentialValue.count()).toBe(0);
    expect(await readCredential(prisma, localStore(), ALICE.oid, "github")).toBeUndefined();
  });

  it("should succeed when there is nothing to delete", async () => {
    expect((await remove(ALICE, "claude")).status).toBe(204);
  });

  it("should answer 404 when the kind is unknown", async () => {
    expect((await remove(ALICE, "ssh")).status).toBe(404);
  });

  it("should remove a stored Bedrock API key when the owner deletes it from the command line", async () => {
    await put(ALICE, "bedrock", { value: BEDROCK });

    expect((await remove(ALICE, "bedrock")).status).toBe(204);

    expect(await prisma.credential.count()).toBe(0);
    expect((await read(ALICE, "bedrock")).status).toBe(404);
  });
});

describe("a Bedrock API key", () => {
  it("should store the caller's key from the command line when it is valid", async () => {
    expect((await put(ALICE, "bedrock", { value: ` ${BEDROCK}\n` })).status).toBe(204);

    expect(await prisma.credential.findFirstOrThrow()).toMatchObject({
      ownerOid: ALICE.oid,
      kind: "bedrock",
      secretName: "u-dev-alice-bedrock",
      updatedVia: "cli"
    });
    expect(await everythingStored()).not.toContain(BEDROCK);
  });

  it("should refuse a pasted GitHub token with an error saying what it is, never echoing it", async () => {
    const response = await put(ALICE, "bedrock", { value: GITHUB });

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("GitHub token, not an Amazon Bedrock API key");
    expect(body).not.toContain(GITHUB);
    expect(await prisma.credential.count()).toBe(0);
  });
});

describe("reading credentials back", () => {
  it("should give the owner their own Bedrock API key when it is stored", async () => {
    await put(ALICE, "bedrock", { value: BEDROCK });

    const response = await read(ALICE, "bedrock");

    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({ value: BEDROCK });
  });

  it("should answer 404 when the owner has no Bedrock API key stored", async () => {
    const response = await read(ALICE, "bedrock");

    expect(response.status).toBe(404);
    expect(await jsonOf(response)).toEqual({ error: "no bedrock credential is stored" });
  });

  it("should give each person only their own Bedrock API key when two have one stored", async () => {
    await put(ALICE, "bedrock", { value: BEDROCK });

    expect((await read(BOB, "bedrock")).status).toBe(404);
  });

  it.each(["github", "azure", "claude", "jenkins"])("should answer 405 and never the value when the owner asks for their stored %s", async (kind) => {
    const values: Record<string, string> = { github: GITHUB, azure: AZURE, claude: CLAUDE, jenkins: JENKINS };
    expect((await put(ALICE, kind, { value: values[kind] })).status).toBe(204);

    const response = await read(ALICE, kind);

    expect(response.status).toBe(405);
    const body = await response.text();
    expect(body).toContain("write-only");
    expect(body).not.toContain(values[kind]!);
  });

  it("should answer 404 when the owner asks for an unknown kind", async () => {
    expect((await read(ALICE, "ssh")).status).toBe(404);
  });

  it("should report what is stored as metadata alone when the status is read", async () => {
    await put(ALICE, "github", { value: GITHUB });
    await put(ALICE, "azure", { value: AZURE });

    const statuses = await credentialStatus(prisma, ALICE.oid);

    expect(statuses.map((status) => [status.kind, status.stored])).toEqual([
      ["github", true],
      ["azure", true],
      ["claude", false],
      ["bedrock", false],
      ["jenkins", false],
      ["claude_md", false]
    ]);
    expect(JSON.stringify(statuses)).not.toContain(GITHUB);
    expect(JSON.stringify(statuses)).not.toContain(AZURE);
  });

  it("should give the settings page metadata and never a value when the viewer has credentials stored", async () => {
    await put(ALICE, "github", { value: GITHUB });

    const settings = await credentialSettings({ ...devIdentity("alice"), modelRoute: "bedrock" });

    expect(settings).toMatchObject({ available: true, modelRoute: "bedrock" });
    expect(JSON.stringify(settings)).not.toContain(GITHUB);
  });

  it("should tell the settings page credentials are unavailable when the deployment cannot store them", async () => {
    vi.stubEnv("CREDENTIALS_VAULT_URL", "https://dtsse-ah-creds-test.vault.azure.net/");

    expect(await credentialSettings({ ...devIdentity("alice"), modelRoute: "bedrock" })).toMatchObject({
      available: false,
      reason: expect.stringContaining("development identity")
    });

    vi.stubEnv("CREDENTIALS_VAULT_URL", "");
    vi.stubEnv("SESSION_SECRET", "");
    expect(await credentialSettings({ ...devIdentity("alice"), modelRoute: "bedrock" })).toMatchObject({ available: false });
  });
});

describe("ownership", () => {
  it("should keep each person's credentials apart when two people store the same kind", async () => {
    await put(ALICE, "github", { value: GITHUB });
    await put(BOB, "github", { value: GITHUB_AGAIN });

    expect(await readCredential(prisma, localStore(), ALICE.oid, "github")).toBe(GITHUB);
    expect(await readCredential(prisma, localStore(), BOB.oid, "github")).toBe(GITHUB_AGAIN);

    await remove(BOB, "github");
    expect(await readCredential(prisma, localStore(), ALICE.oid, "github")).toBe(GITHUB);
  });

  it("should refuse to save or delete someone else's credential when the actor is not the owner", async () => {
    await insertUser(ALICE);
    await insertUser(BOB);
    await put(ALICE, "github", { value: GITHUB });

    await expect(
      putCredential(prisma, localStore(), { actorOid: BOB.oid, ownerOid: ALICE.oid, kind: "github", value: GITHUB_AGAIN, via: "web" })
    ).rejects.toThrow("your own credentials");
    await expect(deleteCredential(prisma, localStore(), { actorOid: BOB.oid, ownerOid: ALICE.oid, kind: "github" })).rejects.toThrow("your own credentials");
    expect(await readCredential(prisma, localStore(), ALICE.oid, "github")).toBe(GITHUB);
  });

  it("should refuse an owner whose oid could not name a secret", async () => {
    await expect(putCredential(prisma, localStore(), { actorOid: "dev-a_b", ownerOid: "dev-a_b", kind: "github", value: GITHUB, via: "web" })).rejects.toThrow(
      "Entra user"
    );
  });

  it("should drop a person's credential metadata when the person is deleted", async () => {
    await put(ALICE, "github", { value: GITHUB });

    await prisma.user.delete({ where: { oid: ALICE.oid } });

    expect(await prisma.credential.count()).toBe(0);
  });
});

describe("saveCredential and removeCredential", () => {
  it("should save a pasted GitHub token as the signed-in person, from the web, when it is valid", async () => {
    actAs("alice");

    const result = await saveCredential(form({ kind: "github", value: ` ${GITHUB}\n`, ownerOid: BOB.oid }));

    expect(result).toEqual({ ok: true, confirmation: "Your GitHub token is stored" });
    const row = await prisma.credential.findFirstOrThrow();
    expect(row).toMatchObject({ ownerOid: devIdentity("alice").oid, kind: "github", updatedVia: "web" });
    expect(revalidated).toContain("/settings/credentials");
    expect(JSON.stringify(result)).not.toContain(GITHUB);
  });

  it("should refuse a Claude token when the viewer's agents use Amazon Bedrock", async () => {
    actAs("alice");

    expect(await saveCredential(form({ kind: "claude", value: CLAUDE }))).toMatchObject({ ok: false, error: expect.stringContaining("Amazon Bedrock") });
    expect(await prisma.credential.count()).toBe(0);
  });

  it("should save a Claude token when the viewer is on their own licence", async () => {
    actAs("own-licence");

    expect(await saveCredential(form({ kind: "claude", value: CLAUDE }))).toEqual({ ok: true, confirmation: "Your Claude token is stored" });
    expect(await readCredential(prisma, localStore(), devIdentity("own-licence").oid, "claude")).toBe(CLAUDE);
  });

  it.each(["alice", "own-licence"])("should save a pasted Bedrock API key from the web when the viewer is the %s persona", async (persona) => {
    actAs(persona);

    const result = await saveCredential(form({ kind: "bedrock", value: BEDROCK }));

    expect(result).toEqual({ ok: true, confirmation: "Your Bedrock API key is stored" });
    expect(await prisma.credential.findFirstOrThrow()).toMatchObject({ ownerOid: devIdentity(persona).oid, kind: "bedrock", updatedVia: "web" });
    expect(await readCredential(prisma, localStore(), devIdentity(persona).oid, "bedrock")).toBe(BEDROCK);
    expect(JSON.stringify(result)).not.toContain(BEDROCK);
  });

  it("should delete a stored Bedrock API key from the web when asked", async () => {
    actAs("alice");
    await saveCredential(form({ kind: "bedrock", value: BEDROCK }));

    expect(await removeCredential(form({ kind: "bedrock" }))).toEqual({ ok: true });
    expect(await prisma.credential.count()).toBe(0);
  });

  it.each([
    ["an Azure cache, which comes from the virtual agent", { kind: "azure", value: AZURE }, "can be pasted here"],
    ["an unknown kind", { kind: "ssh", value: GITHUB }, "can be pasted here"],
    ["a property every object has", { kind: "toString", value: GITHUB }, "can be pasted here"],
    ["a Claude token pasted as a Bedrock API key", { kind: "bedrock", value: CLAUDE }, "Claude token, not an Amazon Bedrock API key"],
    ["a malformed token", { kind: "github", value: "nope" }, "GitHub token"]
  ])("should refuse %s when it is pasted", async (_label, values, error) => {
    actAs("alice");

    expect(await saveCredential(form(values))).toMatchObject({ ok: false, error: expect.stringContaining(error) });
    expect(await prisma.credential.count()).toBe(0);
  });

  it("should say why when the deployment cannot store credentials", async () => {
    actAs("alice");
    vi.stubEnv("CREDENTIALS_VAULT_URL", "http://not-a-vault.example");

    expect(await saveCredential(form({ kind: "github", value: GITHUB }))).toMatchObject({ ok: false, error: expect.stringContaining("https") });
    expect(await removeCredential(form({ kind: "github" }))).toMatchObject({ ok: false, error: expect.stringContaining("https") });
  });

  it("should delete the signed-in person's own credential when asked", async () => {
    actAs("alice");
    await saveCredential(form({ kind: "github", value: GITHUB }));

    expect(await removeCredential(form({ kind: "github" }))).toEqual({ ok: true });
    expect(await prisma.credential.count()).toBe(0);
  });

  it("should refuse to delete when no kind is named", async () => {
    actAs("alice");

    expect(await removeCredential(form({ kind: "" }))).toMatchObject({ ok: false, error: "no credential was named" });
  });
});

describe("a Jenkins API token", () => {
  it("should store the caller's token from the command line when it is valid", async () => {
    expect((await put(ALICE, "jenkins", { value: ` ${JENKINS}\n` })).status).toBe(204);

    expect(await prisma.credential.findFirstOrThrow()).toMatchObject({
      ownerOid: ALICE.oid,
      kind: "jenkins",
      secretName: "u-dev-alice-jenkins",
      updatedVia: "cli"
    });
    expect(await readCredential(prisma, localStore(), ALICE.oid, "jenkins")).toBe(JENKINS);
    expect(await everythingStored()).not.toContain(JENKINS);
  });

  it("should refuse a pasted Claude token with an error saying what it is, never echoing it", async () => {
    const response = await put(ALICE, "jenkins", { value: CLAUDE });

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("Claude token, not a Jenkins API token");
    expect(body).not.toContain(CLAUDE);
    expect(await prisma.credential.count()).toBe(0);
  });

  it("should save a pasted token from the web and list it with the others", async () => {
    actAs("alice");

    expect(await saveCredential(form({ kind: "jenkins", value: JENKINS }))).toEqual({ ok: true, confirmation: "Your Jenkins API token is stored" });

    const statuses = await credentialStatus(prisma, devIdentity("alice").oid);
    expect(statuses.map((status) => [status.kind, status.stored])).toContainEqual(["jenkins", true]);
    expect(revalidated).toEqual(expect.arrayContaining(["/settings/credentials", "/virtual"]));
  });
});

describe("a CLAUDE.md", () => {
  const TEXT = "# Alice\n\n- I work on PCS; private: the payments outage.\n\tIndented line, trailing spaces  \n\n";

  it("should store the caller's text from the command line and give it back to them exactly when they read it", async () => {
    expect((await put(ALICE, "claude_md", { value: TEXT })).status).toBe(204);

    const response = await read(ALICE, "claude_md");

    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({ value: TEXT });
    expect(await prisma.credential.findFirstOrThrow()).toMatchObject({
      ownerOid: ALICE.oid,
      kind: "claude_md",
      secretName: "u-dev-alice-claude-md",
      updatedVia: "cli"
    });
    expect(await everythingStored()).not.toContain("payments outage");
  });

  it("should answer 404, not the default, when the owner has stored none", async () => {
    const response = await read(ALICE, "claude_md");

    expect(response.status).toBe(404);
    expect(await jsonOf(response)).toEqual({ error: "no claude_md credential is stored" });
  });

  it("should never give one person another's CLAUDE.md when both read theirs", async () => {
    await put(ALICE, "claude_md", { value: TEXT });

    const response = await read(BOB, "claude_md");

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("payments outage");
  });

  it("should refuse text with a control character with 400, never echoing it", async () => {
    const response = await put(ALICE, "claude_md", { value: "private context\u0007" });

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("printable text");
    expect(body).not.toContain("private context");
    expect(await prisma.credential.count()).toBe(0);
  });

  it("should refuse text over the byte limit with 400 when it is within the character limit", async () => {
    const response = await put(ALICE, "claude_md", { value: "é".repeat(12_001) });

    expect(response.status).toBe(400);
    expect((await jsonOf(response)).error).toContain("bytes");
  });

  it("should remove it when the owner deletes it from the command line", async () => {
    await put(ALICE, "claude_md", { value: TEXT });

    expect((await remove(ALICE, "claude_md")).status).toBe(204);
    expect((await read(ALICE, "claude_md")).status).toBe(404);
  });

  it("should save the text from the web with LF line endings, as the viewer, and tell the virtual agents page", async () => {
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
    actAs("alice");

    const result = await saveClaudeMd(form({ value: "# Me\r\n\r\nBe brief.\r\n", ownerOid: BOB.oid }));

    expect(result).toEqual({ ok: true, confirmation: "Your CLAUDE.md is saved. Each agent uses it from its next Claude start" });
    expect(await readCredential(prisma, localStore(), devIdentity("alice").oid, "claude_md")).toBe("# Me\n\nBe brief.\n");
    expect(await prisma.credential.findFirstOrThrow()).toMatchObject({ ownerOid: devIdentity("alice").oid, kind: "claude_md", updatedVia: "web" });
    expect(revalidated).toContain("/virtual");
  });

  it("should say why and store nothing when the web save is refused", async () => {
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
    actAs("alice");

    expect(await saveClaudeMd(form({ value: "  \n " }))).toEqual({ ok: false, error: "write your CLAUDE.md, or reset it to the default" });
    expect(await prisma.credential.count()).toBe(0);
  });

  it("should delete the stored text when the viewer resets it to the default", async () => {
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
    actAs("alice");
    await saveClaudeMd(form({ value: TEXT }));

    expect(await resetClaudeMd()).toEqual({ ok: true, confirmation: "Your CLAUDE.md is back to the default" });
    expect(await prisma.credential.count()).toBe(0);
    expect(await prisma.devCredentialValue.count()).toBe(0);
  });

  it("should refuse to save or reset when virtual agents are off", async () => {
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "");
    actAs("alice");

    expect(await saveClaudeMd(form({ value: TEXT }))).toMatchObject({ ok: false, error: expect.stringContaining("not available") });
    expect(await resetClaudeMd()).toMatchObject({ ok: false, error: expect.stringContaining("not available") });
    expect(await prisma.credential.count()).toBe(0);
  });

  it("should say why when the deployment cannot store it", async () => {
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
    actAs("alice");
    vi.stubEnv("CREDENTIALS_VAULT_URL", "http://not-a-vault.example");

    expect(await saveClaudeMd(form({ value: TEXT }))).toMatchObject({ ok: false, error: expect.stringContaining("https") });
    expect(await resetClaudeMd()).toMatchObject({ ok: false, error: expect.stringContaining("https") });
  });

  it("should give the page the default when nothing is stored, and the viewer's own text once it is", async () => {
    const viewer = devIdentity("alice");

    expect(await claudeMdSettings(viewer)).toEqual({ available: true, stored: false, text: DEFAULT_CLAUDE_MD, updatedAt: null });

    await put(ALICE, "claude_md", { value: TEXT });

    expect(await claudeMdSettings(viewer)).toEqual({ available: true, stored: true, text: TEXT, updatedAt: expect.any(String) });
    expect(await claudeMdSettings(devIdentity("bob"))).toMatchObject({ stored: false, text: DEFAULT_CLAUDE_MD });
  });

  it("should tell the page it is unavailable when the deployment cannot store it", async () => {
    vi.stubEnv("CREDENTIALS_VAULT_URL", "https://dtsse-ah-creds-test.vault.azure.net/");
    expect(await claudeMdSettings(devIdentity("alice"))).toMatchObject({ available: false, reason: expect.stringContaining("development identity") });

    vi.stubEnv("CREDENTIALS_VAULT_URL", "");
    vi.stubEnv("SESSION_SECRET", "");
    expect(await claudeMdSettings(devIdentity("alice"))).toMatchObject({ available: false });
  });

  it("should leave it out of the credentials the settings list shows when one is stored", async () => {
    await put(ALICE, "claude_md", { value: TEXT });

    const settings = await credentialSettings({ ...devIdentity("alice"), modelRoute: "bedrock" });

    expect(settings.available && settings.statuses.map((status) => status.kind)).toEqual(["github", "azure", "claude", "bedrock", "jenkins"]);
  });

  it("should not be pasteable as an ordinary credential when the credentials form names it", async () => {
    actAs("alice");

    expect(await saveCredential(form({ kind: "claude_md", value: TEXT }))).toMatchObject({ ok: false, error: expect.stringContaining("can be pasted here") });
  });
});
