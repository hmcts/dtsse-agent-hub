import { describe, expect, it } from "vitest";
import type { Database } from "../store/prisma.ts";
import { readAssistantModel, saveAssistantModel } from "./model-store.ts";
import { DEFAULT_MODEL } from "./models.ts";

/**
 * The reading and the refusal, with the database stood in for: the row the store ends up asking for is the whole of
 * the write, and `test/integration/assistant.test.ts` is where that row is actually written and read back.
 */

const ALICE = "oid-alice";

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

  it.each([
    ["claude-sonnet-5-5"],
    ["eu.anthropic.claude-sonnet-5-5[1m]"],
    ["sonnet --dangerously-skip-permissions"],
    [""],
    [null],
    [{ model: "opus" }]
  ])("should refuse %j and store nothing when it is not a catalogue id", async (model) => {
    const { db, writes } = stub(null);

    await expect(saveAssistantModel(db, ALICE, model)).rejects.toMatchObject({ status: 400, message: "pick a model from the list" });
    expect(writes).toEqual([]);
  });
});
