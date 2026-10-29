import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as searchRoute } from "../../src/app/api/ui/assistant/search/route.ts";
import {
  type ConversationRow,
  conversationAgent,
  createConversation,
  ensureAssistant,
  listConversations,
  renameConversation,
  searchConversations,
  touchConversation
} from "../../src/assistant/store.ts";
import { type ConversationMark, type ConversationMatch, conversationGroups, conversationMatches } from "../../src/assistant/views.ts";
import { directAsPerson } from "../../src/messages/send.ts";
import { byCodePoint } from "../../src/topics/slug.ts";
import { setDesired } from "../../src/virtual-agents/store.ts";
import { insertUser, type Person, person, prisma, resetDatabase } from "./database.ts";
import { jsonOf } from "./routes.ts";

/**
 * Searching the viewer's own Assistant conversations, over the real query: what it matches in a title and in what was
 * said in a chat, and that it never reaches another person's chats, which are owner-only and on no roster.
 */

const ALICE = person("alice");
const BOB = person("bob");

/** A chat of `who`'s, with the messages they sent in it; its title comes from the first, as the real send does. */
async function chat(who: Person, said: readonly string[]): Promise<ConversationRow> {
  const conversation = await createConversation(prisma, who.oid, { product: "pcs" });
  const agentId = await conversationAgent(prisma, conversation);
  for (const [index, body] of said.entries()) {
    await directAsPerson(prisma, who.oid, agentId, body);
    if (index === 0) {
      await touchConversation(prisma, conversation, body);
    }
  }
  return conversation;
}

/** What the assistant answered: a direct message from the chat's agent into the person's own thread. */
async function answered(conversation: ConversationRow, who: Person, body: string): Promise<void> {
  const agentId = await conversationAgent(prisma, conversation);
  await prisma.message.create({ data: { kind: "direct", authorAgentId: agentId, authorOid: who.oid, targetAgentId: null, body } });
}

async function found(who: Person, query: string): Promise<string[]> {
  return (await conversationMatches(prisma, who.oid, query)).map((chat) => chat.title);
}

async function listed(who: Person): Promise<(string | null)[]> {
  return (await listConversations(prisma, who.oid)).map((chat) => chat.title);
}

/** What the sidebar's own grouped list marks each of their chats with, which a search result has to agree with. */
async function marked(who: Person): Promise<Map<string, ConversationMark>> {
  const groups = await conversationGroups(prisma, who.oid);
  return new Map(groups.flatMap((group) => group.items).map((item) => [item.title, item.mark]));
}

/**
 * The chat with its pod taken off it, which is what a local Claude Code session's conversation is: no `virtual_agent`
 * row behind it.
 *
 * Written straight to the row, because nothing creates one of these yet. The pod is taken off last, after the chat's
 * messages and title are in place, since every write to a conversation announces it and an announcement names a pod.
 */
async function withoutPod(conversation: ConversationRow): Promise<void> {
  await prisma.assistantConversation.update({ where: { id: conversation.id }, data: { virtualAgentId: null } });
}

/** The search as the sidebar asks for it: the signed-in person is the development persona in the cookie. */
async function asked(persona: string, query: string): Promise<ConversationMatch[]> {
  const request = new NextRequest(`http://localhost:3000/api/ui/assistant/search?q=${encodeURIComponent(query)}`, {
    headers: { cookie: `ah_dev_persona=${persona}` }
  });
  const response = await searchRoute(request);
  expect(response.status).toBe(200);
  return (await jsonOf<{ chats: ConversationMatch[] }>(response)).chats;
}

beforeEach(async () => {
  await resetDatabase();
  await insertUser(ALICE);
  await insertUser(BOB);
  await ensureAssistant(prisma, { oid: ALICE.oid, modelRoute: "own-licence" });
  await ensureAssistant(prisma, { oid: BOB.oid, modelRoute: "own-licence" });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("searching conversations", () => {
  it("should find a chat by a word in its title", async () => {
    const conversation = await chat(ALICE, ["Something else entirely"]);
    await renameConversation(prisma, ALICE.oid, conversation.id, "Possession claim notes");

    expect(await found(ALICE, "possession")).toEqual(["Possession claim notes"]);
  });

  it("should find a chat by a word in the title however it was typed", async () => {
    const conversation = await chat(ALICE, ["Something else entirely"]);
    await renameConversation(prisma, ALICE.oid, conversation.id, "Possession claim notes");

    expect(await found(ALICE, "POSSESSION")).toEqual(["Possession claim notes"]);
  });

  // The point of searching in English rather than for the letters typed: "claims" and "claim" are the same word.
  it("should find a chat by a word the person remembers in another form", async () => {
    await chat(ALICE, ["The landlord served a possession claim"]);

    expect(await found(ALICE, "claims")).toEqual(["The landlord served a possession claim"]);
    expect(await found(ALICE, "serve")).toEqual(["The landlord served a possession claim"]);
  });

  // Results have to arrive while a word is still being typed, or the box answers nothing until it is finished.
  it("should find a chat by the start of a word", async () => {
    await chat(ALICE, ["The landlord served a possession claim"]);

    expect(await found(ALICE, "posse")).toEqual(["The landlord served a possession claim"]);
  });

  it("should find nothing from the middle of a word, which is not how the words are matched", async () => {
    await chat(ALICE, ["The landlord served a possession claim"]);

    expect(await found(ALICE, "ssession")).toEqual([]);
  });

  it("should find a chat by a word in a message, and show where it matched, when the title does not carry it", async () => {
    const conversation = await chat(ALICE, ["Help me with a tenancy question", "The landlord served a possession claim last week"]);
    await renameConversation(prisma, ALICE.oid, conversation.id, "Tenancy question");

    const matches = await conversationMatches(prisma, ALICE.oid, "possession");

    expect(matches.map((match) => match.title)).toEqual(["Tenancy question"]);
    // The words around the match, which start at the first one the English dictionary has anything to say about.
    expect(matches[0]?.snippet).toBe("landlord served a possession claim last week");
    expect(matches[0]?.id).toBe(conversation.id);
  });

  it("should find a chat by a word in what the assistant answered", async () => {
    const conversation = await chat(ALICE, ["Help me with a tenancy question"]);
    await answered(conversation, ALICE, "A possession order follows if the claim succeeds");

    expect(await found(ALICE, "possession order")).toEqual(["Help me with a tenancy question"]);
  });

  it("should show nothing of the message when the title is already why the chat matched", async () => {
    const conversation = await chat(ALICE, ["Nothing in here about that"]);
    await renameConversation(prisma, ALICE.oid, conversation.id, "Possession claim notes");

    expect((await conversationMatches(prisma, ALICE.oid, "possession"))[0]?.snippet).toBeNull();
  });

  it("should need every word of the query, wherever each of them is", async () => {
    const both = await chat(ALICE, ["The landlord served a possession claim"]);
    await renameConversation(prisma, ALICE.oid, both.id, "Rent arrears");
    await chat(ALICE, ["A possession claim came through"]);

    // "arrears" is only in one chat's title and "possession" only in its message: both have to match, and do.
    expect(await found(ALICE, "arrears possession")).toEqual(["Rent arrears"]);
  });

  it("should find nothing when only some of the words match", async () => {
    await chat(ALICE, ["The landlord served a possession claim"]);

    expect(await found(ALICE, "possession adjournment")).toEqual([]);
  });

  it("should find nothing when no chat matches at all", async () => {
    await chat(ALICE, ["The landlord served a possession claim"]);

    expect(await found(ALICE, "mediation")).toEqual([]);
  });

  it("should find nothing, and ask the database nothing, when the query has no word worth searching for", async () => {
    await chat(ALICE, ["The landlord served a possession claim"]);

    expect(await found(ALICE, " ")).toEqual([]);
    expect(await found(ALICE, "a")).toEqual([]);
  });

  // Each term goes into a tsquery, whose own language has operators; a term carrying them must be matched, not run.
  it("should match punctuation the person typed rather than reading it as a query of its own", async () => {
    await chat(ALICE, ["The hearing is 100% going ahead"]);
    await chat(ALICE, ["Nothing to do with that"]);

    expect(await found(ALICE, "100%")).toEqual(["The hearing is 100% going ahead"]);
    for (const nonsense of ["&", "!(", "'", ":*", "a&!b", "\\"]) {
      expect(await found(ALICE, `${nonsense}xyzzy`)).toEqual([]);
    }
  });

  /**
   * A path, which is what sent an engineer looking for one of these chats in the first place.
   *
   * Asserted as a match rather than as a miss, which is the only way this can be checked: a term that breaks the
   * query matches nothing, so every "finds nothing" assertion above passes just as well when the query is broken as
   * when it works. The two forms here are the two ways a backslash used to break it — with a colon the query was
   * refused outright and the box reported a connection problem, and without one it quietly became a phrase that
   * could never match.
   */
  it.each([["c:\\temp"], ["src\\main"], ["d:\\logs"]])("should find a chat that mentions a path when %s is searched for", async (query) => {
    await chat(ALICE, ["Where did the build output go?", "The log is in c:\\temp, the dump in d:\\logs and the code in src\\main\\java"]);
    await chat(ALICE, ["Nothing like that here"]);

    // The title carries none of it, so the match is in the message, where a path is actually written.
    expect(await found(ALICE, query)).toEqual(["Where did the build output go?"]);
  });

  // "the" has nothing of its own to match on, so it is dropped rather than left to refuse every chat beside a word
  // that does.
  it("should ignore a word of the query that carries no meaning of its own", async () => {
    await chat(ALICE, ["The landlord served a possession claim"]);

    expect(await found(ALICE, "the possession")).toEqual(["The landlord served a possession claim"]);
  });

  it("should find nothing when the query is nothing but words that carry no meaning", async () => {
    await chat(ALICE, ["The landlord served a possession claim"]);

    expect(await found(ALICE, "the and of")).toEqual([]);
  });

  it("should answer most recently active first, as the sidebar's own list does", async () => {
    const older = await chat(ALICE, ["A possession claim came through"]);
    const newer = await chat(ALICE, ["Another possession claim"]);
    await touchConversation(prisma, older, "A possession claim came through", new Date(Date.now() - 60_000));
    await touchConversation(prisma, newer, "Another possession claim", new Date());

    expect(await found(ALICE, "possession")).toEqual(["Another possession claim", "A possession claim came through"]);
  });

  it("should leave out a chat whose assistant is being deleted, as the sidebar's own list does", async () => {
    const conversation = await chat(ALICE, ["A possession claim came through"]);

    await setDesired(prisma, ALICE.oid, conversation.virtualAgentId!, "deleted");

    expect(await found(ALICE, "possession")).toEqual([]);
  });

  it("should answer with no more chats than its limit", async () => {
    for (let n = 0; n < 4; n += 1) {
      await chat(ALICE, [`A possession claim, number ${n}`]);
    }

    expect(await searchConversations(prisma, ALICE.oid, "possession", 2)).toHaveLength(2);
  });
});

/**
 * A chat with no pod is the person's own local Claude Code session.
 *
 * Both reads consult the `virtual_agent` row to leave out a chat whose assistant is being deleted, and both used to
 * drop every one of these on the way past: a relation filter on an optional to-one is false for a row with no related
 * virtual agent, and the search's join was an inner one. So each of these is paired with the exclusion that reading
 * is for — a deleted pod's chat still goes, and still goes for the owner's own list as well as their search.
 */
describe("a chat with no assistant behind it", () => {
  it("should list a chat with no assistant among the person's own", async () => {
    const local = await chat(ALICE, ["A possession claim came through"]);
    await withoutPod(local);

    expect(await listed(ALICE)).toEqual(["A possession claim came through"]);
  });

  it("should find a chat with no assistant by a word in its title", async () => {
    const local = await chat(ALICE, ["Nothing in here about that"]);
    await renameConversation(prisma, ALICE.oid, local.id, "Possession claim notes");
    await withoutPod(local);

    expect(await found(ALICE, "possession")).toEqual(["Possession claim notes"]);
  });

  it("should find a chat with no assistant by a word in a message in it", async () => {
    const local = await chat(ALICE, ["Help me with a tenancy question", "The landlord served a possession claim last week"]);
    await renameConversation(prisma, ALICE.oid, local.id, "Tenancy question");
    await withoutPod(local);

    const matches = await conversationMatches(prisma, ALICE.oid, "possession");

    expect(matches.map((match) => match.title)).toEqual(["Tenancy question"]);
    expect(matches[0]?.snippet).toBe("landlord served a possession claim last week");
  });

  it("should still leave out a chat whose assistant is being deleted, and keep the one with no assistant", async () => {
    const local = await chat(ALICE, ["A possession claim with no assistant"]);
    await withoutPod(local);
    const going = await chat(ALICE, ["A possession claim on an assistant being deleted"]);

    await setDesired(prisma, ALICE.oid, going.virtualAgentId!, "deleted");

    expect(await listed(ALICE)).toEqual(["A possession claim with no assistant"]);
    expect(await found(ALICE, "possession")).toEqual(["A possession claim with no assistant"]);
  });

  // The sidebar's results carry the same marker as the rows in the list below them, so the search has to read the
  // column that decides it rather than leave every result looking like a chat on a pod.
  it("should say of each result whether it is a session on the person's own computer", async () => {
    const local = await chat(ALICE, ["A possession claim with no assistant"]);
    await withoutPod(local);
    await chat(ALICE, ["A possession claim on my assistant"]);

    const matches = await conversationMatches(prisma, ALICE.oid, "possession");

    expect(new Map(matches.map((match) => [match.title, match.mark]))).toEqual(
      new Map([
        ["A possession claim with no assistant", { where: "computer", session: "disconnected" }],
        ["A possession claim on my assistant", { where: "assistant" }]
      ])
    );
  });

  /**
   * A result's mark is coloured by the state of its session, as a row in the list below it is, so the search's own
   * query has to bring the current agent's status back with each match: without it every laptop found by searching
   * would be marked the same whatever its session was doing.
   */
  it.each([
    ["busy", "working"],
    ["idle", "ready"],
    ["offline", "disconnected"]
  ] as const)("should mark a result that is a local chat as %s with the state of its session", async (status, session) => {
    const local = await chat(ALICE, ["A possession claim with no assistant"]);
    await withoutPod(local);
    await prisma.agent.updateMany({ where: { assistantConversationId: local.id }, data: { status } });

    const matches = await conversationMatches(prisma, ALICE.oid, "possession");

    expect(matches.map((match) => match.mark)).toEqual([{ where: "computer", session }]);
  });

  /**
   * Whether a pod chat is marked as one is a fact about the person's whole list, and the sidebar's list and its
   * search are two requests apart: the page renders one and the browser asks the route for the other. Both read it
   * through `hasLocalConversation`, which is what keeps them from answering differently for the same person.
   */
  it("should mark a pod chat the same in the sidebar's list and in the search for the same person", async () => {
    const ON_POD = "A possession claim on my assistant";
    const ON_LAPTOP = "A possession claim with no assistant";
    await chat(ALICE, [ON_POD]);

    // Nothing of theirs is local yet, so neither read marks the pod chat: there is nothing to tell it apart from.
    expect(await marked(ALICE)).toEqual(new Map([[ON_POD, null]]));
    expect(new Map((await asked("alice", "possession")).map((match) => [match.title, match.mark]))).toEqual(new Map([[ON_POD, null]]));

    await withoutPod(await chat(ALICE, [ON_LAPTOP]));

    const mixed = new Map([
      [ON_LAPTOP, { where: "computer", session: "disconnected" }],
      [ON_POD, { where: "assistant" }]
    ]);
    expect(await marked(ALICE)).toEqual(mixed);
    expect(new Map((await asked("alice", "possession")).map((match) => [match.title, match.mark]))).toEqual(mixed);
  });

  it("should find nothing of another person's chat that has no assistant either", async () => {
    const local = await chat(BOB, ["Bob asked about a possession claim"]);
    await withoutPod(local);

    expect(await found(ALICE, "possession")).toEqual([]);
    expect(await listed(ALICE)).toEqual([]);
  });
});

/**
 * The half that matters. A conversation is its owner's, and a share of one is reached by its own address rather than
 * offered among anybody's chats, so search is the one surface that could have widened. Each of these asserts that
 * the *same words* that find a person's own chat find nothing at all for anybody else — by title, by what they
 * wrote, and by what the assistant answered them — so the test fails both if the query stopped filtering by owner
 * and if it filtered by something weaker, such as the virtual agent.
 */
describe("searching someone else's conversations", () => {
  let bobsTitle: string;

  beforeEach(async () => {
    const titled = await chat(BOB, ["Nothing about that in here"]);
    await renameConversation(prisma, BOB.oid, titled.id, "Possession claim notes");
    const said = await chat(BOB, ["Bob asked about a possession claim"]);
    await answered(said, BOB, "An adjournment is possible");
    bobsTitle = "Possession claim notes";
  });

  it("should find nothing of another person's chats, by title or by anything said in them", async () => {
    expect(await found(ALICE, "possession")).toEqual([]);
    expect(await found(ALICE, "adjournment")).toEqual([]);
    expect(await found(ALICE, "bob")).toEqual([]);
  });

  it("should still find them for the person they belong to", async () => {
    expect(await found(BOB, "possession")).toEqual(expect.arrayContaining([bobsTitle]));
    expect(await found(BOB, "adjournment")).toEqual(["Bob asked about a possession claim"]);
  });

  it("should find only the signed-in person's own chats when the sidebar asks", async () => {
    await chat(ALICE, ["Alice asked about a possession claim"]);

    expect((await asked("alice", "possession")).map((chat) => chat.title)).toEqual(["Alice asked about a possession claim"]);
    expect((await asked("bob", "possession")).map((chat) => chat.title).sort(byCodePoint)).toEqual(["Bob asked about a possession claim", bobsTitle]);
  });

  it("should find nothing for a person who has no chats of their own", async () => {
    expect(await asked("carol", "possession")).toEqual([]);
  });
});
