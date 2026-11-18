import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockHub, type MockHub } from "../__fixtures__/mock-hub.ts";
import { type Api, ApiError, createApi } from "../api.ts";
import { CLIENT_FEATURES } from "../features.ts";
import type { DocmosisSchema } from "../wire.ts";
import { UsageError } from "./command.ts";
import { checkDocx, checkJsonObject, checkName, checkSchemaObject, checkSummary, DocmosisConversationMissingError, publishDocmosis } from "./docmosis.ts";

const VID = "va-docmosis";
const LAUNCH = `launch-${"e".repeat(16)}`;
const DOCX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 7, 7, 7]);
const SCHEMA: DocmosisSchema = {
  root: { kind: "object", controls: [], notes: [], properties: { name: { kind: "string", controls: [], notes: [] } } },
  warnings: []
};
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

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

  it("should throw the hub's refusal, when it answers the publish with an error other than a conflict", async () => {
    // Arrange
    const agentId = await conversationAgent();

    // Act
    const result = publishDocmosis(api, agentId, { ...input, schema: { ...SCHEMA, root: { ...SCHEMA.root, kind: "string" } } as unknown as DocmosisSchema });

    // Assert
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({ status: 400 });
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
    expect(check).toThrow(/refusing to send: the text contains a secret-shaped string \(pattern /);
  });

  it.each([
    ["an undefined item", { items: [1, undefined] }, "undefined at $.items[1]"],
    ["a hole in an array", { items: Object.assign([1], { 2: 2 }) }, "undefined at $.items[1]"],
    ["an undefined property", { name: undefined }, "undefined at $.name"],
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

  it("should refuse it with the refusal given, when the name is blank or too long", () => {
    // Act
    const blank = () => checkName("  ", "give one with --name");
    const long = () => checkName("n".repeat(201));

    // Assert
    expect(blank).toThrow("give one with --name");
    expect(long).toThrow(UsageError);
  });
});

describe("checkSummary", () => {
  it("should return the summary, when it is 1 to 200 characters", () => {
    // Act
    const summary = checkSummary("Loaded claim-form");

    // Assert
    expect(summary).toBe("Loaded claim-form");
  });

  it("should refuse it, when the summary is blank or too long", () => {
    // Act
    const blank = () => checkSummary("\n");
    const long = () => checkSummary("s".repeat(201), "--summary is too long");

    // Assert
    expect(blank).toThrow("the summary must be 1 to 200 characters saying what changed");
    expect(long).toThrow("--summary is too long");
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
