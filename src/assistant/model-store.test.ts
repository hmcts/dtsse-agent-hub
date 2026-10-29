import { describe, expect, it } from "vitest";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { assistantModelChoice, readAssistantModel, saveAssistantModel } from "./model-store.ts";
import { DEFAULT_MODEL } from "./models.ts";

/**
 * The reading and the refusal, with the database stood in for: the row the store ends up asking for is the whole of
 * the write, and `test/integration/assistant.test.ts` is where that row is actually written and read back.
 */

const ALICE = "oid-alice";
const ASSISTANT = "va-1";

function stub(stored: { ownerOid: string; model: string } | null) {
  const writes: { ownerOid: string; model: string }[] = [];
  const db = {
    assistantModelChoice: {
      findUnique: async ({ where }: { where: { ownerOid: string } }) => (where.ownerOid === stored?.ownerOid ? { model: stored.model } : null),
      upsert: async ({ where, update }: { where: { ownerOid: string }; update: { model: string } }) => {
        writes.push({ ownerOid: where.ownerOid, model: update.model });
        return { ownerOid: where.ownerOid, model: update.model };
      }
    }
  } as unknown as Database;
  return { db, writes };
}

describe("readAssistantModel", () => {
  it("should answer the stored model when the person has chosen one", async () => {
    const { db } = stub({ ownerOid: ALICE, model: "opus" });

    expect(await readAssistantModel(db, ALICE)).toBe("opus");
  });

  it("should answer the default when the person has chosen nothing", async () => {
    const { db } = stub(null);

    expect(await readAssistantModel(db, ALICE)).toBe(DEFAULT_MODEL);
  });

  it("should answer the default when the stored model has left the catalogue", async () => {
    const { db } = stub({ ownerOid: ALICE, model: "claude-haiku-5-5" });

    expect(await readAssistantModel(db, ALICE)).toBe(DEFAULT_MODEL);
  });

  it("should answer the default for a person whose row is somebody else's", async () => {
    const { db } = stub({ ownerOid: "oid-bob", model: "opus" });

    expect(await readAssistantModel(db, ALICE)).toBe(DEFAULT_MODEL);
  });
});

describe("saveAssistantModel", () => {
  it("should store a catalogue id and answer it when the person picks one", async () => {
    const { db, writes } = stub(null);

    expect(await saveAssistantModel(db, ALICE, "opus")).toBe("opus");
    expect(writes).toEqual([{ ownerOid: ALICE, model: "opus" }]);
  });

  it.each([["claude-sonnet-5-5"], ["eu.anthropic.claude-sonnet-5-5[1m]"], ["sonnet --dangerously-skip-permissions"], [""], [null], [{ model: "opus" }]])(
    "should refuse %j and store nothing when it is not a catalogue id",
    async (model) => {
      const { db, writes } = stub(null);

      await expect(saveAssistantModel(db, ALICE, model)).rejects.toMatchObject({ status: 400, message: "pick a model from the list" });
      expect(writes).toEqual([]);
    }
  );
});

/**
 * The pod claim the Model section reads, which comes from the virtual agent's current agent — the supervisor's own
 * registration — as the Files and Size sections' reports do.
 */
function podStub(clientFeatures: unknown, owner = ALICE) {
  return {
    assistantModelChoice: { findUnique: async () => ({ model: "opus" }) },
    virtualAgent: {
      findUnique: async ({ where }: { where: { id: string; ownerOid: string } }) =>
        where.id === ASSISTANT && where.ownerOid === owner ? { agent: { clientFeatures } } : null
    }
  } as unknown as PrismaClient;
}

describe("assistantModelChoice", () => {
  it("should report the choice honoured when the pod's own session claims the aliases", async () => {
    expect(await assistantModelChoice(podStub(["model", "model-alias"]), ALICE, ASSISTANT)).toEqual({ model: "opus", honoured: true });
  });

  it("should report it not honoured when the pod claims the older model feature alone", async () => {
    expect(await assistantModelChoice(podStub(["model"]), ALICE, ASSISTANT)).toEqual({ model: "opus", honoured: false });
  });

  it("should report it not honoured when the pod's session claimed nothing at all", async () => {
    expect(await assistantModelChoice(podStub(null), ALICE, ASSISTANT)).toEqual({ model: "opus", honoured: false });
  });

  it("should report it not honoured when the assistant has no session on it yet", async () => {
    const db = { assistantModelChoice: { findUnique: async () => ({ model: "opus" }) }, virtualAgent: { findUnique: async () => ({ agent: null }) } };

    expect(await assistantModelChoice(db as unknown as PrismaClient, ALICE, ASSISTANT)).toEqual({ model: "opus", honoured: false });
  });

  it("should still answer the stored choice, not honoured, when the agent is somebody else's", async () => {
    expect(await assistantModelChoice(podStub(["model-alias"], "oid-bob"), ALICE, ASSISTANT)).toEqual({ model: "opus", honoured: false });
  });
});
