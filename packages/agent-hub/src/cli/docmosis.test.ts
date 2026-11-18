import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockHub, type MockHub } from "../__fixtures__/mock-hub.ts";
import { type Api, ApiError, createApi } from "../api.ts";
import { CLIENT_FEATURES } from "../features.ts";
import type { DocmosisSchema } from "../wire.ts";
import { UsageError } from "./command.ts";
import {
  checkDocx,
  checkJsonObject,
  checkName,
  checkSchemaObject,
  checkSummary,
  DocmosisConversationMissingError,
  jsonbText,
  publishDocmosis
} from "./docmosis.ts";

const VID = "va-docmosis";
const LAUNCH = `launch-${"e".repeat(16)}`;
const DOCX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 7, 7, 7]);
const SCHEMA: DocmosisSchema = {
  root: { kind: "object", controls: [], notes: [], properties: { name: { kind: "string", controls: [], notes: [] } } },
  warnings: []
};
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** An object `levels` deep, itself the first, each level made by `wrap`. */
const nested = (levels: number, wrap: (inner: unknown) => unknown = (inner) => ({ inner })): unknown => {
  let value: unknown = {};
  for (let level = 1; level < levels; level += 1) {
    value = wrap(value);
  }
  return value;
};

describe("publishDocmosis", () => {
  let hub: MockHub;
  let api: Api;
  let nextConversation = 0;

  beforeAll(async () => {
    hub = createMockHub({ launchTokens: { [LAUNCH]: { virtualId: VID, owner: { oid: "oid-owner" } } } });
    api = createApi({ baseUrl: await hub.listen(), launchToken: LAUNCH });
  });

  afterAll(async () => {
    await hub.close();
  });

  async function conversationAgent({ conversation = true }: { conversation?: boolean } = {}): Promise<string> {
    nextConversation += 1;
    const sid = `publish-sess-${nextConversation}`;
    const { agent_id } = await api.register({
      session_id: sid,
      name: sid,
      name_source: "derived",
      client_features: [...CLIENT_FEATURES],
      ...(conversation ? { conversation_id: `1f8a6a1e-0000-4000-8000-${String(nextConversation).padStart(12, "0")}` } : {})
    });
    return agent_id;
  }

  const input = { docx: DOCX, schema: SCHEMA, data: { name: "Ada" }, name: "Claim form", base: 0 };

  it("should upload the .docx by its digest and publish version 1, when the conversation has no template", async () => {
    // Arrange
    const agentId = await conversationAgent();

    // Act
    const result = await publishDocmosis(api, agentId, { ...input, summary: "First draft" });

    // Assert
    expect(result).toEqual({ written: { version: 1, revision: 0 } });
    const stored = hub.docmosisTemplates.get(agentId);
    expect(stored?.assets.get(digest(DOCX))).toEqual(DOCX);
    expect(stored?.versions[0]).toMatchObject({ name: "Claim form", docx: `sha256:${digest(DOCX)}`, data: { name: "Ada" }, summary: "First draft" });
    const put = hub.calls.find((c) => c.method === "PUT" && c.path === `/api/agent/${agentId}/docmosis`);
    expect(put?.body).toEqual({
      name: "Claim form",
      docx: `sha256:${digest(DOCX)}`,
      schema: SCHEMA,
      data: { name: "Ada" },
      base_version: 0,
      summary: "First draft"
    });
  });

  it("should send the base revision, when one is given", async () => {
    // Arrange
    const agentId = await conversationAgent();
    await publishDocmosis(api, agentId, input);

    // Act
    const result = await publishDocmosis(api, agentId, { ...input, base: 1, baseRevision: 0 });

    // Assert
    expect(result).toEqual({ written: { version: 2, revision: 0 } });
    const puts = hub.calls.filter((c) => c.method === "PUT" && c.path === `/api/agent/${agentId}/docmosis`);
    expect(puts.at(-1)?.body).toMatchObject({ base_version: 1, base_revision: 0 });
    expect(puts.at(-1)?.body).not.toHaveProperty("summary");
  });

  it.each([
    ["the version that load wrote, for a pick an earlier run of its job already loaded", "pick-1", { written: { version: 4, revision: 0 } }],
    ["a conflict, for a write that named no pick", undefined, { conflict: { current: null } }]
  ])("should answer %s when the hub refuses the write with a 409 naming a loaded version", async (_label, pick, expected) => {
    // Arrange
    const loadedAlready = {
      putDocmosisAsset: async () => ({ asset: `sha256:${digest(DOCX)}` }),
      createDocmosis: async () => Promise.reject(new Error("not here")),
      putDocmosis: async () => Promise.reject(new ApiError(409, { error: "already loaded", loaded: { version: 4, revision: 0 } }, "PUT", "/docmosis"))
    };

    // Act
    const result = await publishDocmosis(loadedAlready, "agent-1", { ...input, ...(pick === undefined ? {} : { pick }) });

    // Assert
    expect(result).toEqual(expected);
  });

  it("should return the template as it is now and publish nothing, when someone wrote a newer version", async () => {
    // Arrange
    const agentId = await conversationAgent();
    await publishDocmosis(api, agentId, input);
    hub.writeDocmosisAsUser(agentId, { name: "Grace" });

    // Act
    const result = await publishDocmosis(api, agentId, { ...input, base: 1 });

    // Assert
    expect(result).toMatchObject({ conflict: { current: { version: 2, by: "user", data: { name: "Grace" } } } });
    expect(hub.docmosisTemplates.get(agentId)?.versions).toHaveLength(2);
  });

  it("should return a conflict, when the person amended the version read since its revision", async () => {
    // Arrange
    const agentId = await conversationAgent();
    await publishDocmosis(api, agentId, input);
    hub.writeDocmosisAsUser(agentId, { name: "Grace" });
    hub.writeDocmosisAsUser(agentId, { name: "Hopper" }, { amend: true });

    // Act
    const result = await publishDocmosis(api, agentId, { ...input, base: 2, baseRevision: 0 });

    // Assert
    expect(result).toMatchObject({ conflict: { current: { version: 2, revision: 1 } } });
  });

  it("should return a conflict with no current template, when the hub refuses the base without saying what it is now", async () => {
    // Arrange
    const agentId = await conversationAgent();

    // Act
    const result = await publishDocmosis(api, agentId, { ...input, base: 1 });

    // Assert
    expect(result).toEqual({ conflict: { current: null } });
  });

  it("should throw DocmosisConversationMissingError, when the hub has no conversation for the agent", async () => {
    // Arrange
    const agentId = await conversationAgent({ conversation: false });

    // Act
    const result = publishDocmosis(api, agentId, input);

    // Assert
    await expect(result).rejects.toBeInstanceOf(DocmosisConversationMissingError);
    await expect(result).rejects.toThrow(`the hub has no CFT Workspace conversation for agent ${agentId}`);
  });

  it("should refuse the name or summary and send nothing, when either is outside the hub's limits", async () => {
    // Arrange
    const agentId = await conversationAgent();
    const before = hub.calls.length;

    // Act
    const blankName = publishDocmosis(api, agentId, { ...input, name: " " });
    const longName = publishDocmosis(api, agentId, { ...input, name: "n".repeat(201) });
    const blankSummary = publishDocmosis(api, agentId, { ...input, summary: "" });
    const longSummary = publishDocmosis(api, agentId, { ...input, summary: "s".repeat(201) });

    // Assert
    await expect(blankName).rejects.toThrow("the template's name must be 1 to 200 characters");
    await expect(longName).rejects.toBeInstanceOf(UsageError);
    await expect(blankSummary).rejects.toThrow("the summary must be 1 to 200 characters saying what changed");
    await expect(longSummary).rejects.toBeInstanceOf(UsageError);
    expect(hub.calls.slice(before).filter((c) => c.path.startsWith(`/api/agent/${agentId}/docmosis`))).toEqual([]);
  });

  it("should send the name and summary trimmed, when they have whitespace around them", async () => {
    // Arrange
    const agentId = await conversationAgent();

    // Act
    await publishDocmosis(api, agentId, { ...input, name: "  Claim form\n", summary: "\tFirst draft " });

    // Assert
    const put = hub.calls.find((c) => c.method === "PUT" && c.path === `/api/agent/${agentId}/docmosis`);
    expect(put?.body).toMatchObject({ name: "Claim form", summary: "First draft" });
  });

  it("should throw the hub's refusal, when it answers the publish with an error other than a conflict", async () => {
    // Arrange
    const agentId = await conversationAgent();

    // Act
    const result = publishDocmosis(api, agentId, { ...input, schema: { ...SCHEMA, root: { ...SCHEMA.root, kind: "string" } } as unknown as DocmosisSchema });

    // Assert
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({ status: 400 });
  });

  it("should make a further template and return its id, when create is given and the conversation already holds one", async () => {
    // Arrange
    const agentId = await conversationAgent();
    await publishDocmosis(api, agentId, input);

    // Act
    const result = await publishDocmosis(api, agentId, { ...input, name: "Order", create: true });

    // Assert
    expect(result).toEqual({ written: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), version: 1, revision: 0 } });
    expect(hub.moreDocmosis.get(agentId)).toHaveLength(1);
    expect(hub.docmosisTemplates.get(agentId)?.versions).toHaveLength(1);
  });

  it("should write the template the item names and leave the primary alone, when an item is given", async () => {
    // Arrange
    const agentId = await conversationAgent();
    await publishDocmosis(api, agentId, input);
    const created = await publishDocmosis(api, agentId, { ...input, name: "Order", create: true });
    const id = "written" in created ? (created.written.id as string) : "";

    // Act
    const result = await publishDocmosis(api, agentId, { ...input, name: "Order", base: 1, item: id });

    // Assert
    expect(result).toEqual({ written: { version: 2, revision: 0 } });
    expect(hub.docmosisTemplates.get(agentId)?.versions).toHaveLength(1);
  });

  it("should return a conflict for an item whose version moved on, and say the template is gone for one that is not held, when an item is given", async () => {
    // Arrange
    const agentId = await conversationAgent();
    await publishDocmosis(api, agentId, input);
    const created = await publishDocmosis(api, agentId, { ...input, name: "Order", create: true });
    const id = "written" in created ? (created.written.id as string) : "";

    // Act
    const stale = await publishDocmosis(api, agentId, { ...input, base: 0, item: id });
    const gone = publishDocmosis(api, agentId, { ...input, item: "00000000-0000-4000-8000-00000000dead" });

    // Assert
    expect("conflict" in stale).toBe(true);
    await expect(gone).rejects.toThrow(/there is no template 00000000-0000-4000-8000-00000000dead/);
  });

  it("should throw the hub's refusal rather than report a conflict, when a new template is refused with a 409", async () => {
    // Arrange
    const agentId = await conversationAgent();
    const refused = {
      ...api,
      createDocmosis: async () => Promise.reject(new ApiError(409, { error: "your assistant needs an update" }, "POST", "/docmosis-templates"))
    };

    // Act & Assert
    await expect(publishDocmosis(refused, agentId, { ...input, create: true })).rejects.toBeInstanceOf(ApiError);
  });
});

describe("checkSchemaObject", () => {
  it("should return the schema, when it has a root of kind object", () => {
    // Act
    const schema = checkSchemaObject(structuredClone(SCHEMA), "schema.json");

    // Assert
    expect(schema).toEqual(SCHEMA);
  });

  it("should refuse it, naming its source, when the value is not an object", () => {
    // Act
    const check = () => checkSchemaObject([SCHEMA], "schema.json");

    // Assert
    expect(check).toThrow(UsageError);
    expect(check).toThrow("schema.json must hold the schema object");
  });

  it("should refuse it, when the object has no root of kind object", () => {
    // Act
    const check = () => checkSchemaObject({ root: { kind: "string" }, warnings: [] }, "schema.json");

    // Assert
    expect(check).toThrow('schema.json is not a schema from docmosis schema: it has no root of kind "object"');
  });

  it("should refuse it, when the schema holds text a jsonb cannot store", () => {
    // Act
    const check = () => checkSchemaObject({ ...SCHEMA, warnings: [`bad${String.fromCharCode(0)}`] }, "schema.json");

    // Assert
    expect(check).toThrow(/schema schema\.json has text the hub cannot store/);
  });

  it("should refuse it, when the schema is larger than the hub stores as Postgres prints it", () => {
    // Act
    const check = () => checkSchemaObject({ ...SCHEMA, warnings: ["x".repeat(120_000)] }, "schema.json");

    // Assert
    expect(check).toThrow(/schema schema\.json is larger than the hub takes, 120000 bytes/);
  });
});

describe("checkJsonObject", () => {
  it("should name what the value is meant to be, when it is not an object", () => {
    // Act
    const check = () => checkJsonObject(null, "data", "data.json");

    // Assert
    expect(check).toThrow("data.json must hold the data object");
  });

  it("should refuse it with the secret check's error, when the value holds secret-shaped text", () => {
    // Arrange: built at runtime so no secret-shaped literal sits in the repo.
    const secret = `${"gh"}p_${"Q".repeat(30)}`;

    // Act
    const check = () => checkJsonObject({ notes: [`token ${secret}`] }, "data", "the loader");

    // Assert
    expect(check).toThrow(UsageError);
    expect(check).toThrow(/refusing to send: the text contains a secret-shaped string \(pattern /);
  });

  it.each([
    ["an undefined item", { items: [1, undefined] }, "undefined at $.items[1]"],
    ["a hole in an array", { items: Object.assign([1], { 2: 2 }) }, "undefined at $.items[1]"],
    ["a function", { render: () => "x" }, "a function at $.render"],
    ["a symbol", { tag: Symbol("t") }, "a symbol at $.tag"],
    ["a bigint", { count: 10n }, "a bigint at $.count"],
    ["a non-finite number", { ratio: Number.NaN }, "NaN at $.ratio"],
    ["a Date", { when: new Date(0) }, "a Date object at $.when"],
    ["a Map", { lookup: new Map() }, "a Map object at $.lookup"]
  ])("should refuse it, naming where, when the value holds %s", (_, value, found) => {
    // Act
    const check = () => checkJsonObject(value, "data", "the loader");

    // Assert
    expect(check).toThrow(UsageError);
    expect(check).toThrow(`data the loader holds ${found}, which JSON cannot carry`);
  });

  it("should return the value, when a property is undefined, which JSON leaves out", () => {
    // Arrange
    const value = { name: "Ada", nickname: undefined, nested: { gone: undefined } };

    // Act
    const checked = checkJsonObject(value, "data", "the loader");

    // Assert
    expect(checked).toBe(value);
  });

  it("should refuse it, when the value holds an unstorable key", () => {
    // Act
    const check = () => checkJsonObject({ [`bad${String.fromCharCode(0)}`]: 1 }, "data", "the loader");

    // Assert
    expect(check).toThrow("data the loader has text the hub cannot store: a NUL character, or half of a surrogate pair");
  });

  it("should return the value, when it nests 64 levels as the hub allows", () => {
    // Act
    const checked = checkJsonObject(nested(64), "data", "the loader");

    // Assert
    expect(checked).toEqual(nested(64));
  });

  it("should refuse it with a UsageError, when it nests more than 64 levels", () => {
    // Act
    const tooDeep = () => checkJsonObject(nested(65), "data", "the loader");
    const deepArray = () => checkJsonObject({ list: nested(64, (inner) => [inner]) }, "data", "the loader");
    const farTooDeep = () => checkJsonObject(nested(200_000), "data", "the loader");

    // Assert
    expect(tooDeep).toThrow(UsageError);
    expect(tooDeep).toThrow("data the loader nests more than 64 levels");
    expect(deepArray).toThrow("data the loader nests more than 64 levels");
    expect(farTooDeep).toThrow(UsageError);
  });

  it("should refuse it, when an object already checked shallower is shared again deeper than 64 levels", () => {
    // Arrange
    const shared = nested(10);
    let deep: unknown = shared;
    for (let level = 0; level < 60; level += 1) {
      deep = { inner: deep };
    }
    const value = { first: shared, second: deep };

    // Act
    const check = () => checkJsonObject(value, "data", "the loader");

    // Assert
    expect(check).toThrow("data the loader nests more than 64 levels");
  });

  it("should refuse it by its stored size without expanding it, when a subtree is shared many times over", () => {
    // Arrange: 2^50 copies of the leaf once written out.
    let value: Record<string, unknown> = { leaf: "x" };
    for (let level = 0; level < 50; level += 1) {
      value = { a: value, b: value };
    }

    // Act
    const check = () => checkJsonObject(value, "data", "the loader");

    // Assert
    expect(check).toThrow("data the loader is larger than the hub takes, 120000 bytes as the hub stores it");
  });

  it("should take it at exactly the hub's size and refuse one byte more, when a shared object counts once for each place it appears", () => {
    // Arrange: {"a": {"k": "…"}, "b": {"k": "…"}} is 32 bytes around its two texts.
    const sized = (length: number) => {
      const shared = { k: "y".repeat(length) };
      return { a: shared, b: shared };
    };
    const atLimit = sized((120_000 - 32) / 2);

    // Act
    const fits = () => checkJsonObject(atLimit, "data", "the loader");
    const over = () => checkJsonObject(sized((120_000 - 32) / 2 + 1), "data", "the loader");

    // Assert
    expect(jsonbText(atLimit)).toHaveLength(120_000);
    expect(fits).not.toThrow();
    expect(over).toThrow("data the loader is larger than the hub takes, 120000 bytes as the hub stores it");
  });

  it("should refuse it, when the value refers to itself", () => {
    // Arrange
    const value: Record<string, unknown> = { name: "Ada" };
    value.self = { back: value };

    // Act
    const check = () => checkJsonObject(value, "data", "the loader");

    // Assert
    expect(check).toThrow("data the loader holds a reference to itself at $.self.back, which JSON cannot carry");
  });

  it("should quote the key, when it is not a plain identifier", () => {
    // Act
    const check = () => checkJsonObject({ "odd key": Number.POSITIVE_INFINITY }, "data", "the loader");

    // Assert
    expect(check).toThrow('data the loader holds Infinity at $["odd key"], which JSON cannot carry');
  });

  it("should return the value, when the same object appears twice without a cycle", () => {
    // Arrange
    const shared = { name: "Ada" };
    const value = { first: shared, second: shared, nothing: null, list: [true, 1.5, "x"] };

    // Act
    const checked = checkJsonObject(value, "data", "the loader");

    // Assert
    expect(checked).toBe(value);
  });
});

describe("checkName", () => {
  it("should return the name, when it is 1 to 200 characters", () => {
    // Act
    const name = checkName("n".repeat(200));

    // Assert
    expect(name).toBe("n".repeat(200));
  });

  it("should return it trimmed, when it is 200 characters once its whitespace is trimmed", () => {
    // Act
    const name = checkName(`  ${"n".repeat(200)}\n`);

    // Assert
    expect(name).toBe("n".repeat(200));
  });

  it("should refuse it, when the name is blank or too long", () => {
    // Act
    const blank = () => checkName("  ");
    const long = () => checkName("n".repeat(201));

    // Assert
    expect(blank).toThrow("the template's name must be 1 to 200 characters");
    expect(long).toThrow(UsageError);
  });

  it.each([
    ["a NUL character", `Claim${String.fromCharCode(0)}form`],
    ["a lone high surrogate", "Claim \ud83d form"],
    ["a lone low surrogate", "Claim \ude00 form"]
  ])("should refuse it, when the name holds %s", (_, name) => {
    // Act
    const check = () => checkName(name);

    // Assert
    expect(check).toThrow(UsageError);
    expect(check).toThrow("the template's name must not contain a NUL character or half of a surrogate pair");
  });

  it("should return it, when the name holds a whole surrogate pair", () => {
    // Act
    const name = checkName("Claim \ud83d\ude00");

    // Assert
    expect(name).toBe("Claim 😀");
  });
});

describe("checkSummary", () => {
  it("should return the summary, when it is 1 to 200 characters", () => {
    // Act
    const summary = checkSummary("Loaded claim-form");

    // Assert
    expect(summary).toBe("Loaded claim-form");
  });

  it("should return it trimmed and keep its line breaks, when it has whitespace around and within it", () => {
    // Act
    const summary = checkSummary(` Added the\nhearing date${" ".repeat(200)}`);

    // Assert
    expect(summary).toBe("Added the\nhearing date");
  });

  it("should refuse it, when the summary is blank or too long", () => {
    // Act
    const blank = () => checkSummary("\n");
    const long = () => checkSummary("s".repeat(201));

    // Assert
    expect(blank).toThrow("the summary must be 1 to 200 characters saying what changed");
    expect(long).toThrow(UsageError);
  });

  it("should refuse it, when the summary holds a NUL character or a lone surrogate", () => {
    // Act
    const nul = () => checkSummary(`Added${String.fromCharCode(0)}`);
    const surrogate = () => checkSummary("Added \udc00");

    // Assert
    expect(nul).toThrow("the summary must not contain a NUL character or half of a surrogate pair");
    expect(surrogate).toThrow(UsageError);
  });
});

describe("checkDocx", () => {
  it("should return the bytes, when they start with the zip magic", () => {
    // Act
    const bytes = checkDocx(DOCX, "claim.docx");

    // Assert
    expect(bytes).toBe(DOCX);
  });

  it("should refuse them, naming their source, when the bytes are not a zip", () => {
    // Act
    const check = () => checkDocx(Buffer.from("%PDF-1.7"), "claim.docx");

    // Assert
    expect(check).toThrow(UsageError);
    expect(check).toThrow("claim.docx is not a .docx");
  });

  it("should refuse it, when the .docx is larger than the hub takes", () => {
    // Arrange
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    DOCX.copy(big);

    // Act
    const check = () => checkDocx(big, "claim.docx");

    // Assert
    expect(check).toThrow(`the template claim.docx is larger than the hub takes, ${5 * 1024 * 1024} bytes`);
  });
});
