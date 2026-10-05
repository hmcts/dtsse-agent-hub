import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as credentialRoute from "../../src/app/api/agent/credentials/[kind]/route.ts";
import { credentialBackend } from "../../src/credentials/backend.ts";
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
const { removeCredential, saveCredential } = await import("../../src/app/_actions/credentials.ts");
const { credentialSettings } = await import("../../src/web/data.ts");

const { PUT, DELETE } = credentialRoute;

const ALICE = person("alice");
const BOB = person("bob");

const GITHUB = `ghp_${"A1b2".repeat(9)}`;
const GITHUB_AGAIN = `ghp_${"Z9y8".repeat(9)}`;
const CLAUDE = `sk-ant-oat01-${"Qw_-".repeat(12)}`;
const AZURE = gzipSync(
  Buffer.from(JSON.stringify({ Account: { a: { username: "alice@example.com" } }, RefreshToken: { r: { secret: "refresh-secret" } } }))
).toString("base64");

function put(as: Person, kind: string, body: unknown): Promise<Response> {
  return call(PUT, { as, path: `/api/agent/credentials/${kind}`, method: "PUT", params: { kind }, body });
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
});

describe("reading credentials back", () => {
  it("should offer no way to read a value back through the agent API when a credential is stored", async () => {
    await put(ALICE, "github", { value: GITHUB });

    const methods = Object.keys(credentialRoute)
      .filter((name) => /^[A-Z]+$/.test(name))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    expect(methods).toEqual(["DELETE", "PUT"]);
  });

  it("should report what is stored as metadata alone when the status is read", async () => {
    await put(ALICE, "github", { value: GITHUB });
    await put(ALICE, "azure", { value: AZURE });

    const statuses = await credentialStatus(prisma, ALICE.oid);

    expect(statuses.map((status) => [status.kind, status.stored])).toEqual([
      ["github", true],
      ["azure", true],
      ["claude", false]
    ]);
    expect(JSON.stringify(statuses)).not.toContain(GITHUB);
    expect(JSON.stringify(statuses)).not.toContain(AZURE);
  });

  it("should give the settings page metadata and never a value when the viewer has credentials stored", async () => {
    await put(ALICE, "github", { value: GITHUB });

    const settings = await credentialSettings({ ...devIdentity("alice"), modelRoute: "gateway" });

    expect(settings).toMatchObject({ available: true, modelRoute: "gateway" });
    expect(JSON.stringify(settings)).not.toContain(GITHUB);
  });

  it("should tell the settings page credentials are unavailable when the deployment cannot store them", async () => {
    vi.stubEnv("CREDENTIALS_VAULT_URL", "https://dtsse-ah-creds-test.vault.azure.net/");

    expect(await credentialSettings({ ...devIdentity("alice"), modelRoute: "gateway" })).toMatchObject({
      available: false,
      reason: expect.stringContaining("development identity")
    });

    vi.stubEnv("CREDENTIALS_VAULT_URL", "");
    vi.stubEnv("SESSION_SECRET", "");
    expect(await credentialSettings({ ...devIdentity("alice"), modelRoute: "gateway" })).toMatchObject({ available: false });
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

  it("should refuse a Claude token when the viewer's agents use the AI gateway", async () => {
    actAs("alice");

    expect(await saveCredential(form({ kind: "claude", value: CLAUDE }))).toMatchObject({ ok: false, error: expect.stringContaining("AI gateway") });
    expect(await prisma.credential.count()).toBe(0);
  });

  it("should save a Claude token when the viewer is on their own licence", async () => {
    actAs("own-licence");

    expect(await saveCredential(form({ kind: "claude", value: CLAUDE }))).toEqual({ ok: true, confirmation: "Your Claude token is stored" });
    expect(await readCredential(prisma, localStore(), devIdentity("own-licence").oid, "claude")).toBe(CLAUDE);
  });

  it.each([
    ["an Azure cache, which comes from the virtual agent", { kind: "azure", value: AZURE }, "GitHub or Claude"],
    ["an unknown kind", { kind: "ssh", value: GITHUB }, "GitHub or Claude"],
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
