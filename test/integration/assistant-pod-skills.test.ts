import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Skill } from "../../src/agents/skills.ts";
import { ensureAssistant } from "../../src/assistant/assistant-store.ts";
import { BRIEFING_SKILL } from "../../src/assistant/briefing.ts";
import { createConversation } from "../../src/assistant/conversation-store.ts";
import { podSkills } from "../../src/assistant/views.ts";
import type { VirtualAgentRow } from "../../src/virtual-agents/store.ts";
import { insertUser, person, prisma, resetDatabase } from "./database.ts";

/** Which of a pod's sessions `podSkills` reads the skills of, which is what decides whether the briefing is offered. */

const ALICE = person("alice");

let assistant: VirtualAgentRow;

beforeEach(async () => {
  await resetDatabase();
  await insertUser(ALICE);
  assistant = await ensureAssistant(prisma, { oid: ALICE.oid, modelRoute: "own-licence" });
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A session of Alice's pod that has registered and reported `skills`, last heard from `minutesAgo`. */
async function session(skills: Skill[], minutesAgo: number): Promise<void> {
  await prisma.agent.create({
    data: {
      ownerOid: ALICE.oid,
      sessionId: `session-${Math.random().toString(36).slice(2)}`,
      name: assistant.name,
      status: "idle",
      virtualAgentId: assistant.id,
      skills: skills.map((skill) => ({ ...skill })),
      lastHeartbeatAt: new Date(Date.now() - minutesAgo * 60_000)
    }
  });
}

const BRIEFING = { name: BRIEFING_SKILL, description: "The day ahead" };
const MAIL = { name: "m365:mail", description: "Mail" };

describe("podSkills", () => {
  it("should give the skills of a session that reported them when a newer chat's agent has not registered yet", async () => {
    await session([MAIL, BRIEFING], 5);
    await createConversation(prisma, ALICE.oid, { product: "pcs" });

    expect((await podSkills(prisma, assistant)).map((skill) => skill.name)).toEqual(["m365:mail", BRIEFING_SKILL]);
  });

  it("should give the newest reporting session's skills when two sessions have reported", async () => {
    await session([MAIL, BRIEFING], 30);
    await session([MAIL], 5);

    expect((await podSkills(prisma, assistant)).map((skill) => skill.name)).toEqual(["m365:mail"]);
  });

  it("should give no skills when no session has reported any", async () => {
    await createConversation(prisma, ALICE.oid, { product: "pcs" });

    expect(await podSkills(prisma, assistant)).toEqual([]);
  });
});
