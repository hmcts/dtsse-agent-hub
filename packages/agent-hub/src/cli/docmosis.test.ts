import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockHub, type MockHub } from "../__fixtures__/mock-hub.ts";
import { type Api, ApiError, createApi } from "../api.ts";
import { CLIENT_FEATURES } from "../features.ts";
import type { DocmosisSchema } from "../wire.ts";
import { UsageError } from "./command.ts";
import { checkDocx, checkJsonObject, checkSchemaObject, publishDocmosis } from "./docmosis.ts";

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
    expect(result).toMatchObject({ conflict: { version: 2, by: "user", data: { name: "Grace" } } });
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
    expect(result).toMatchObject({ conflict: { version: 2, revision: 1 } });
  });

  it("should say the session is not a conversation, when the hub has no template for the agent", async () => {
    // Arrange
    const agentId = await conversationAgent({ conversation: false });

    // Act
    const result = publishDocmosis(api, agentId, input);

    // Assert
    await expect(result).rejects.toThrow(/not a CFT Workspace conversation/);
  });

  it("should throw the hub's refusal, when it answers the publish with an error other than a conflict", async () => {
    // Arrange
    const agentId = await conversationAgent();

    // Act
    const result = publishDocmosis(api, agentId, { ...input, name: "" });

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

  it("should refuse a value that is not an object, naming its source", () => {
    // Act
    const check = () => checkSchemaObject([SCHEMA], "schema.json");

    // Assert
    expect(check).toThrow(UsageError);
    expect(check).toThrow("schema.json must hold the schema object");
  });

  it("should refuse an object with no root of kind object", () => {
    // Act
    const check = () => checkSchemaObject({ root: { kind: "string" }, warnings: [] }, "schema.json");

    // Assert
    expect(check).toThrow('schema.json is not a schema from docmosis schema: it has no root of kind "object"');
  });

  it("should refuse a schema holding text a jsonb cannot store", () => {
    // Act
    const check = () => checkSchemaObject({ ...SCHEMA, warnings: [`bad${String.fromCharCode(0)}`] }, "schema.json");

    // Assert
    expect(check).toThrow(/schema schema\.json has text the hub cannot store/);
  });

  it("should refuse a schema larger than the hub stores, measured as Postgres prints it", () => {
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
});

describe("checkDocx", () => {
  it("should return the bytes, when they start with the zip magic", () => {
    // Act
    const bytes = checkDocx(DOCX, "claim.docx");

    // Assert
    expect(bytes).toBe(DOCX);
  });

  it("should refuse bytes that are not a zip, naming their source", () => {
    // Act
    const check = () => checkDocx(Buffer.from("%PDF-1.7"), "claim.docx");

    // Assert
    expect(check).toThrow(UsageError);
    expect(check).toThrow("claim.docx is not a .docx");
  });

  it("should refuse a .docx larger than the hub takes", () => {
    // Arrange
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    DOCX.copy(big);

    // Act
    const check = () => checkDocx(big, "claim.docx");

    // Assert
    expect(check).toThrow(`the template claim.docx is larger than the hub takes, ${5 * 1024 * 1024} bytes`);
  });
});
