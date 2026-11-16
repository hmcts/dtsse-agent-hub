import { describe, expect, it } from "vitest";
import type { Database } from "../store/prisma.ts";
import { readAssistantSchedule, saveAssistantSchedule } from "./schedule-store.ts";

/**
 * The reading and the refusals, with the database stood in for; `test/integration/virtual-agents-sweep.test.ts` is
 * where the stored row is written, read back and acted on.
 */

const ALICE = "oid-alice";

function stub(stored: { autoStartTime: string | null; idleAfter: string | null } | null) {
  const writes: { ownerOid: string; autoStartTime: string | null; idleAfter: string | null }[] = [];
  const db = {
    assistantSchedule: {
      findUnique: async () => stored,
      upsert: async ({ where, update }: { where: { ownerOid: string }; update: { autoStartTime: string | null; idleAfter: string | null } }) => {
        writes.push({ ownerOid: where.ownerOid, autoStartTime: update.autoStartTime, idleAfter: update.idleAfter });
      }
    }
  } as unknown as Database;
  return { db, writes };
}

describe("readAssistantSchedule", () => {
  it("should answer no auto start and the deployment's idle period when the person has stored nothing", async () => {
    expect(await readAssistantSchedule(stub(null).db, ALICE)).toEqual({ autoStartTime: null, idleAfter: null });
  });

  it("should answer what is stored when the person has chosen both", async () => {
    expect(await readAssistantSchedule(stub({ autoStartTime: "08:30", idleAfter: "never" }).db, ALICE)).toEqual({ autoStartTime: "08:30", idleAfter: "never" });
  });

  it("should answer none for a stored value the form no longer offers", async () => {
    expect(await readAssistantSchedule(stub({ autoStartTime: "06:00", idleAfter: "9h" }).db, ALICE)).toEqual({ autoStartTime: null, idleAfter: null });
  });
});

describe("saveAssistantSchedule", () => {
  it("should store both and answer them when they are offered", async () => {
    const { db, writes } = stub(null);

    expect(await saveAssistantSchedule(db, ALICE, { autoStart: "08:00", idleAfter: "3h" })).toEqual({ autoStartTime: "08:00", idleAfter: "3h" });
    expect(writes).toEqual([{ ownerOid: ALICE, autoStartTime: "08:00", idleAfter: "3h" }]);
  });

  it("should store nothing for none and the default when that is what they chose", async () => {
    const { db, writes } = stub(null);

    expect(await saveAssistantSchedule(db, ALICE, { autoStart: "none", idleAfter: "default" })).toEqual({ autoStartTime: null, idleAfter: null });
    expect(writes).toEqual([{ ownerOid: ALICE, autoStartTime: null, idleAfter: null }]);
  });

  it.each(["07:00", "19:00", "08:15", "", undefined, 8])("should refuse %s as an auto start time and write nothing when it is no slot", async (autoStart) => {
    const { db, writes } = stub(null);

    await expect(saveAssistantSchedule(db, ALICE, { autoStart, idleAfter: "2h" })).rejects.toMatchObject({ status: 400 });
    expect(writes).toEqual([]);
  });

  it.each(["0h", "5h", "forever", "", undefined])("should refuse %s as an idle period and write nothing when it is not offered", async (idleAfter) => {
    const { db, writes } = stub(null);

    await expect(saveAssistantSchedule(db, ALICE, { autoStart: "08:00", idleAfter })).rejects.toMatchObject({ status: 400 });
    expect(writes).toEqual([]);
  });
});
