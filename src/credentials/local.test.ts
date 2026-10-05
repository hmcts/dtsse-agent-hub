import { describe, expect, it } from "vitest";
import { createLocalStore, LocalStoreRefused, localKey, openValue, type SealedValue, sealValue } from "./local.ts";

const SECRET = "a-session-secret-long-enough-to-seal-with";
const DEV = { NODE_ENV: "development" };

interface Row extends SealedValue {
  secretName: string;
  updatedAt?: Date;
}

/** The three `devCredentialValue` calls the store makes, over a Map. */
function fakeDb() {
  const rows = new Map<string, Row>();
  const db = {
    devCredentialValue: {
      upsert: async ({ where, create, update }: { where: { secretName: string }; create: Row; update: Partial<Row> }) => {
        const existing = rows.get(where.secretName);
        rows.set(where.secretName, existing === undefined ? create : { ...existing, ...update });
      },
      findUnique: async ({ where }: { where: { secretName: string } }) => rows.get(where.secretName) ?? null,
      deleteMany: async ({ where }: { where: { secretName: string } }) => ({ count: rows.delete(where.secretName) ? 1 : 0 })
    }
  };
  return { rows, db: db as never };
}

describe("sealValue and openValue", () => {
  const key = localKey(SECRET);

  it("should carry a value back out unchanged when the key and name match", () => {
    expect(openValue(key, "u-dev-a-github", sealValue(key, "u-dev-a-github", "ghp_value ✓"))).toBe("ghp_value ✓");
  });

  it("should not put the value where the database can read it when sealing", () => {
    const sealed = sealValue(key, "n", "ghp_plaintext");

    expect(Buffer.from(sealed.ciphertext).toString("utf8")).not.toContain("plaintext");
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.tag).toHaveLength(16);
  });

  it("should use a fresh iv each time when the same value is sealed twice", () => {
    expect(Buffer.from(sealValue(key, "n", "v").iv).equals(Buffer.from(sealValue(key, "n", "v").iv))).toBe(false);
  });

  it("should refuse to open a value when it was sealed under another secret", () => {
    const sealed = sealValue(localKey("another-secret-entirely"), "n", "v");

    expect(() => openValue(key, "n", sealed)).toThrow();
  });

  it("should refuse to open a value when it has been copied to another name", () => {
    expect(() => openValue(key, "u-dev-b-github", sealValue(key, "u-dev-a-github", "v"))).toThrow();
  });

  it("should refuse to open a value when its ciphertext has been altered", () => {
    const sealed = sealValue(key, "n", "a value");
    sealed.ciphertext[0] = (sealed.ciphertext[0] ?? 0) ^ 1;

    expect(() => openValue(key, "n", sealed)).toThrow();
  });

  it("should derive a key that differs from the session secret's own when given the same secret", () => {
    expect(localKey(SECRET)).toHaveLength(32);
    expect(localKey(SECRET).equals(Buffer.from(SECRET).subarray(0, 32))).toBe(false);
    expect(localKey(SECRET).equals(localKey(SECRET))).toBe(true);
  });
});

describe("createLocalStore", () => {
  it("should refuse to exist when NODE_ENV is production", () => {
    expect(() => createLocalStore({ db: fakeDb().db, secret: SECRET, env: { NODE_ENV: "production" } })).toThrow(LocalStoreRefused);
  });

  it("should store a value sealed and read it back when used outside production", async () => {
    const { rows, db } = fakeDb();
    const store = createLocalStore({ db, secret: SECRET, env: DEV });

    await store.put("u-dev-a-github", "ghp_value", {});

    expect(Buffer.from(rows.get("u-dev-a-github")!.ciphertext).toString("utf8")).not.toContain("ghp_value");
    expect(await store.get("u-dev-a-github")).toBe("ghp_value");
  });

  it("should replace a value when it is saved again", async () => {
    const store = createLocalStore({ ...fakeDb(), secret: SECRET, env: DEV });

    await store.put("n", "first", {});
    await store.put("n", "second", {});

    expect(await store.get("n")).toBe("second");
  });

  it("should read nothing when the value has been removed or was never stored", async () => {
    const store = createLocalStore({ ...fakeDb(), secret: SECRET, env: DEV });
    await store.put("n", "v", {});

    await store.remove("n");
    await store.remove("never-stored");

    expect(await store.get("n")).toBeUndefined();
    expect(await store.get("never-stored")).toBeUndefined();
  });

  it("should accept development identities when it is the local store", () => {
    expect(createLocalStore({ ...fakeDb(), secret: SECRET, env: DEV }).acceptsDevIdentities).toBe(true);
  });

  it("should read the process environment when none is given", () => {
    expect(() => createLocalStore({ ...fakeDb(), secret: SECRET })).not.toThrow();
  });
});
