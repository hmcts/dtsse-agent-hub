import type pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as heartbeat } from "../../src/app/api/agent/[agentId]/heartbeat/route.ts";
import { POST as register } from "../../src/app/api/agent/register/route.ts";
import { decodeEvent, HUB_CHANNEL, type NotifiedEvent } from "../../src/realtime/events.ts";
import { connect, person, prisma, resetDatabase } from "./database.ts";
import { call, jsonOf } from "./routes.ts";

const ALICE = person("alice");

const REGISTRATION = { session_id: "session-1", name: "alice-pcs-api", cwd: null, repo: "pcs-api", branch: "master", host: null };
const SKILLS = [
  { name: "repo-sync", description: "Fast-forward clones" },
  { name: "cft-explain", description: "Explain a CFT topic" }
];

let listener: pg.Client;
let heard: NotifiedEvent[];

beforeEach(async () => {
  await resetDatabase();
  heard = [];
  listener = await connect();
  listener.on("notification", (notification) => {
    const event = decodeEvent(notification.payload);
    if (event !== undefined) {
      heard.push(event);
    }
  });
  await listener.query(`LISTEN ${HUB_CHANNEL}`);
});

afterEach(async () => {
  await listener.end();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** The skills announcements heard so far. A round trip on the listener's connection first, so every NOTIFY committed before it has arrived. */
async function skillEvents(): Promise<NotifiedEvent[]> {
  await listener.query("SELECT 1");
  return heard.filter((event) => event.type === "agent_skills");
}

/** Drops what has been heard, once every NOTIFY committed so far has arrived. */
async function forget(): Promise<void> {
  await listener.query("SELECT 1");
  heard = [];
}

async function registered(body: object = REGISTRATION): Promise<string> {
  const response = await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body });
  expect(response.status).toBe(200);
  return (await jsonOf(response)).agent_id;
}

async function beat(agentId: string, body: object): Promise<void> {
  const response = await call(heartbeat, { as: ALICE, path: `/api/agent/${agentId}/heartbeat`, method: "POST", params: { agentId }, body });
  expect(response.status).toBe(204);
}

describe("skills announcements on heartbeat", () => {
  it("should announce the agent's skills when a heartbeat changes them", async () => {
    const agentId = await registered({ ...REGISTRATION, skills: SKILLS });
    await forget();

    await beat(agentId, { status: "idle", skills: [...SKILLS, { name: "pcs:start-env", description: "" }] });

    expect(await skillEvents()).toEqual([{ type: "agent_skills", agent_id: agentId, owner_oid: ALICE.oid }]);
  });

  it("should not announce the skills when a heartbeat sends the stored list again, in any order", async () => {
    const agentId = await registered({ ...REGISTRATION, skills: SKILLS });
    await forget();

    await beat(agentId, { status: "busy", skills: [SKILLS[1], SKILLS[0]] });

    expect(await skillEvents()).toEqual([]);
    expect(heard.map((event) => event.type)).toEqual(["agent_status"]);
  });

  it("should not announce the skills when a heartbeat does not send them", async () => {
    const agentId = await registered({ ...REGISTRATION, skills: SKILLS });
    await forget();

    await beat(agentId, { status: "idle" });

    expect(await skillEvents()).toEqual([]);
  });

  it("should announce the skills when a heartbeat clears them", async () => {
    const agentId = await registered({ ...REGISTRATION, skills: SKILLS });
    await forget();

    await beat(agentId, { status: "idle", skills: [] });

    expect(await skillEvents()).toEqual([{ type: "agent_skills", agent_id: agentId, owner_oid: ALICE.oid }]);
  });
});

describe("skills announcements on register", () => {
  it("should not announce a new agent's skills when it first registers", async () => {
    await registered({ ...REGISTRATION, skills: SKILLS });

    expect(await skillEvents()).toEqual([]);
  });

  it("should announce the skills when a re-registration changes them", async () => {
    const agentId = await registered({ ...REGISTRATION, skills: SKILLS });
    await forget();

    expect(await registered({ ...REGISTRATION, skills: SKILLS.slice(0, 1) })).toBe(agentId);

    expect(await skillEvents()).toEqual([{ type: "agent_skills", agent_id: agentId, owner_oid: ALICE.oid }]);
  });

  it("should not announce the skills when a re-registration sends the same list or none", async () => {
    await registered({ ...REGISTRATION, skills: SKILLS });
    await forget();

    await registered({ ...REGISTRATION, skills: SKILLS });
    await registered(REGISTRATION);

    expect(await skillEvents()).toEqual([]);
  });
});
