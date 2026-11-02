import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockHub, type MockHub, type StoredAgent, type StoredMessage } from "../../packages/agent-hub/src/__fixtures__/mock-hub.ts";
import { type AgentRef, canAgentMessageAgent, canReadMessage, type MessageRef, replyRoute, tagRefusal } from "./rules.ts";

/**
 * The published client tests against an in-memory hub, `packages/agent-hub/src/__fixtures__/mock-hub.ts`, which
 * cannot import these rules: the package ships without the app. So it carries its own copy, and this is what holds
 * the copy to them. Every case is a request to the mock; the status it answers has to be the one these rules give for
 * the same rows, read back out of the mock's own state.
 */

const ALICE = { oid: "oid-alice", name: "Alice Smith", email: "alice@example.com" };
const BOB = { oid: "oid-bob", name: "Bob Jones", email: "bob@example.com" };
const CAROL = { oid: "oid-carol", name: "Carol", email: "carol@example.com" };
const LAUNCH = `launch-${"c".repeat(16)}`;
const VIRTUAL_ID = "0f8a6a1e-1234-4000-8000-0000000000c1";

let hub: MockHub;
let url: string;

beforeAll(async () => {
  hub = createMockHub({ launchTokens: { [LAUNCH]: { virtualId: VIRTUAL_ID, owner: ALICE } } });
  url = await hub.listen();
});

afterAll(async () => {
  await hub.close();
});

type Person = typeof ALICE;

const devUser = (person: Person) => ({ "X-Dev-User": `${person.oid}|${person.name}|${person.email}` });

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

let sessions = 0;

async function register(person: Person, extra: Record<string, unknown> = {}, headers: Record<string, string> = devUser(person)): Promise<string> {
  sessions += 1;
  const { json } = await call("POST", "/api/agent/register", headers, { session_id: `contract-${sessions}`, name: `contract-${sessions}`, ...extra });
  return json.agent_id;
}

async function post(agentId: string, person: Person, body: Record<string, unknown> = {}): Promise<{ status: number; json: any }> {
  return await call("POST", `/api/agent/${agentId}/posts`, devUser(person), { topics: ["contract"], title: "t", body: "b", ...body });
}

function agentRef(id: string | null | undefined): AgentRef | null {
  const agent = id ? hub.agents.get(id) : undefined;
  if (!agent) {
    return null;
  }
  return { id: agent.id, ownerOid: agent.owner_oid, ownerOnly: isPodConversation(agent) };
}

function isPodConversation(agent: StoredAgent): boolean {
  return agent.conversation_id !== undefined && agent.virtual_id !== undefined;
}

function messageRef(id: string): MessageRef {
  const message = hub.messages.find((m) => String(m.id) === id) as StoredMessage;
  const parent = message.in_reply_to ? hub.messages.find((m) => String(m.id) === String(message.in_reply_to)) : undefined;
  return {
    kind: message.kind as MessageRef["kind"],
    authorOid: message.author_oid,
    authorAgent: agentRef(message.author_agent_id),
    targetAgent: agentRef(message.target_agent_id),
    parentAuthorOid: parent?.author_oid ?? null
  };
}

describe("the client's mock hub against the access rules", () => {
  it("should answer a private reply with the status replyRoute gives when every kind of message is replied to", async () => {
    // Arrange
    const sender = await register(ALICE);
    const sibling = await register(ALICE);
    const bobs = await register(BOB);
    const cases: Record<string, string> = {
      "its own post": (await post(sender, ALICE)).json.message.id,
      "a post by its owner's other agent": (await post(sibling, ALICE)).json.message.id,
      "a post by another owner's agent": (await post(bobs, BOB)).json.message.id,
      "a post by a person": hub.addPost({ topics: ["contract"], bodyText: "b", user: BOB }).id,
      "a direct it received": hub.sendDirectFromOwner(sender, "for the sender").id,
      "a direct to its owner's other agent": hub.sendDirectFromOwner(sibling, "for the sibling").id
    };

    for (const [name, id] of Object.entries(cases)) {
      // Act
      const expected = replyRoute(agentRef(sender) as AgentRef, messageRef(id));
      const answered = await call("POST", `/api/agent/${sender}/direct`, devUser(ALICE), { reply_to_message: id, body: "reply" });

      // Assert
      expect([name, answered.status], answered.json?.error).toEqual([name, expected.to === "nobody" ? expected.status : 201]);
      if (expected.to === "nobody") {
        expect(answered.json.error).toBe(expected.reason);
      }
    }
  });

  it("should answer a read with the status canReadMessage gives when the reader is and is not on the message", async () => {
    // Arrange
    const alices = await register(ALICE);
    const bobs = await register(BOB);
    const alicePost = hub.addPost({ topics: ["contract"], bodyText: "b", user: ALICE });
    const carolPost = hub.addPost({ topics: ["contract"], bodyText: "b", user: CAROL });
    const cases: Record<string, string> = {
      "another owner's post": (await post(bobs, BOB)).json.message.id,
      "a direct to the reader's own agent": hub.sendDirectFromOwner(alices, "mine").id,
      "a direct to another owner's agent": hub.sendDirectFromOwner(bobs, "bob's").id,
      "an agent's reply to the reader's post": (await call("POST", `/api/agent/${bobs}/direct`, devUser(BOB), { reply_to_message: alicePost.id, body: "r" }))
        .json.message.id,
      "an agent's reply to someone else's post": (await call("POST", `/api/agent/${bobs}/direct`, devUser(BOB), { reply_to_message: carolPost.id, body: "r" }))
        .json.message.id
    };

    for (const [name, id] of Object.entries(cases)) {
      // Act
      const read = await call("GET", `/api/agent/messages/${id}`, devUser(ALICE));

      // Assert
      expect([name, read.status]).toEqual([name, canReadMessage(ALICE.oid, messageRef(id)) ? 200 : 403]);
    }
  });

  it("should answer a tag and a direct by id with the statuses tagRefusal and canAgentMessageAgent give when each kind of agent is named", async () => {
    // Arrange
    const sender = await register(ALICE);
    const cases: Record<string, string> = {
      "the author itself": sender,
      "its owner's other agent": await register(ALICE),
      "another owner's agent": await register(BOB),
      "its owner's Assistant conversation": await register(
        ALICE,
        { conversation_id: "0f8a6a1e-0000-4000-8000-0000000000c2" },
        { Authorization: `Bearer ${LAUNCH}` }
      )
    };
    const tagStatus = { itself: 400, not_taggable: 404 } as const;

    for (const [name, id] of Object.entries(cases)) {
      // Act
      const target = agentRef(id) as AgentRef;
      const refusal = tagRefusal(sender, target);
      const tagged = await post(sender, ALICE, { tag_agents: [id] });
      const directed = await call("POST", `/api/agent/${sender}/direct`, devUser(ALICE), { to_agent: id, body: "hi" });

      // Assert
      expect([name, tagged.status]).toEqual([name, refusal === undefined ? 201 : tagStatus[refusal]]);
      expect([name, directed.status]).toEqual([name, canAgentMessageAgent(agentRef(sender) as AgentRef, target) ? 201 : 403]);
    }
  });
});
