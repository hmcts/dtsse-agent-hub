import { describe, expect, it } from "vitest";
import {
  type AgentRef,
  agentLookup,
  attachmentDownload,
  type ConversationShare,
  canActAsVirtualAgent,
  canAgentMessageAgent,
  canAttachUpload,
  canChangeDeck,
  canForkConversation,
  canLaunchTokenActForAgent,
  canLaunchTokenReadMessage,
  canManageVirtualAgent,
  canOpenVirtualAgentPort,
  canOwnerReadCredential,
  canPersonDirectAgent,
  canReadDeck,
  canReadMessage,
  canRemoveUploadFromDisk,
  canSessionUseAttachment,
  canShareConversationWith,
  canSuggestPerson,
  canUseCredentialRoutes,
  canViewTranscript,
  canVirtualAgentStoreCredential,
  canWriteUpload,
  conversationAccess,
  isOwner,
  isPodConversationAgent,
  MAX_PEOPLE_SUGGESTIONS,
  type MessageRef,
  MIN_PEOPLE_QUERY,
  peopleLookup,
  replyRoute,
  type SharedConversationRef,
  tagRefusal,
  type UploadRef
} from "./rules.ts";

const OWNER = "oid-owner";
/** Somebody else who uses the hub. There is nothing they can hold over the owner's agents, which is the point. */
const COLLEAGUE = "oid-colleague";
const ELSEWHERE = "oid-elsewhere";

const TARGET: AgentRef = { id: "agent-owned", ownerOid: OWNER };

function agentOf(ownerOid: string): AgentRef {
  return { id: `agent-of-${ownerOid}`, ownerOid };
}

type Role = "owner" | "colleague";

const ROLES: Record<Role, string> = { owner: OWNER, colleague: COLLEAGUE };

/** Every refusal a colleague gets. Each one is the same single fact: the thing is somebody else's. */
const EVERYONE_ELSE: readonly [string, string][] = [
  ["a colleague", COLLEAGUE],
  ["another owner", ELSEWHERE]
];

/** A direct message from the owner's other agent to the owner's agent. */
const DIRECT_TO_TARGET: MessageRef = {
  kind: "direct",
  authorOid: OWNER,
  authorAgent: { id: "agent-other", ownerOid: OWNER },
  targetAgent: TARGET,
  parentAuthorOid: null
};

describe("isOwner", () => {
  it("should allow the owner when the row is their own", () => {
    expect(isOwner(OWNER, TARGET)).toBe(true);
    expect(isOwner(OWNER, { ownerOid: OWNER })).toBe(true);
  });

  it.each(EVERYONE_ELSE)("should refuse %s when the row is the owner's", (_label, oid) => {
    expect(isOwner(oid, TARGET)).toBe(false);
    expect(isOwner(oid, { ownerOid: OWNER })).toBe(false);
  });
});

/**
 * Seeing an agent, reading its transcript, messaging it and reading its thread are one answer: whether the viewer owns
 * it.
 */
describe.each<[Role, boolean]>([
  ["owner", true],
  ["colleague", false]
])("access for the %s", (role, expected) => {
  const oid = ROLES[role];

  it(`should ${expected ? "" : "not "}show the agent's transcript when the viewer is the ${role}`, () => {
    expect(canViewTranscript(oid, TARGET)).toBe(expected);
  });

  it(`should ${expected ? "" : "not "}let an agent message the agent when its owner is the ${role}`, () => {
    expect(canAgentMessageAgent(agentOf(oid), TARGET)).toBe(expected);
  });

  it(`should ${expected ? "" : "not "}let the ${role} read a direct message to the agent`, () => {
    expect(canReadMessage(oid, DIRECT_TO_TARGET)).toBe(expected);
  });

  it(`should let the ${role} read any post`, () => {
    expect(canReadMessage(oid, { kind: "post", authorOid: ELSEWHERE, authorAgent: agentOf(ELSEWHERE), targetAgent: null, parentAuthorOid: null })).toBe(true);
  });

  it(`should ${expected ? "" : "not "}route a private reply to the owner's post when the replying agent's owner is the ${role}`, () => {
    const post: MessageRef = { kind: "post", authorOid: OWNER, authorAgent: TARGET, targetAgent: null, parentAuthorOid: null };
    const route = replyRoute(agentOf(oid), post);
    expect(route.to).toBe(expected ? "agent" : "nobody");
  });
});

/**
 * What a colleague has instead, which is the whole reason the rules above may be this narrow: they tag the agent in
 * a post, which needs nothing of them and reaches the agent on the stream it already holds.
 */
describe("reaching somebody else's agent", () => {
  it("should let a colleague's agent tag the owner's agent in a post", () => {
    expect(tagRefusal(agentOf(COLLEAGUE).id, TARGET)).toBeUndefined();
  });

  it("should let a colleague tag the owner's agent from the web UI, where they post as themselves", () => {
    expect(tagRefusal(null, TARGET)).toBeUndefined();
  });

  it("should still refuse the colleague everything the tag does not carry", () => {
    expect(isOwner(COLLEAGUE, TARGET)).toBe(false);
    expect(canViewTranscript(COLLEAGUE, TARGET)).toBe(false);
  });
});
describe("canAgentMessageAgent", () => {
  // The case that has to keep working: a person's own sessions talking to each other, which is what a direct
  // message now is.
  it("should let an agent message another agent of the same owner", () => {
    expect(canAgentMessageAgent(agentOf(OWNER), TARGET)).toBe(true);
  });

  it("should refuse an agent messaging another owner's agent, which a tagged post is for", () => {
    expect(canAgentMessageAgent(agentOf(ELSEWHERE), TARGET)).toBe(false);
  });
});

describe("canPersonDirectAgent", () => {
  const laptop = { id: "a-laptop", ownerOid: OWNER, virtualAgentId: null, ownerOnly: false };
  const conversation = { id: "a-chat", ownerOid: OWNER, virtualAgentId: "va-1", ownerOnly: true };
  const podOwnSession = { id: "a-pod", ownerOid: OWNER, virtualAgentId: "va-1", ownerOnly: false };

  it("should let the owner message a session on their computer and a pod's conversation", () => {
    expect(canPersonDirectAgent(OWNER, laptop)).toBe(true);
    expect(canPersonDirectAgent(OWNER, conversation)).toBe(true);
  });

  it("should refuse the owner a virtual agent's own session, which the Assistant never writes to", () => {
    expect(canPersonDirectAgent(OWNER, podOwnSession)).toBe(false);
  });

  it("should refuse a colleague every one of the owner's agents", () => {
    for (const agent of [laptop, conversation, podOwnSession]) {
      expect(canPersonDirectAgent(COLLEAGUE, agent)).toBe(false);
    }
  });
});

describe("canReadMessage", () => {
  it("should put a reply to a person in the replying agent's thread when it has no target", () => {
    const reply: MessageRef = { kind: "direct", authorOid: OWNER, authorAgent: TARGET, targetAgent: null, parentAuthorOid: null };

    expect(canReadMessage(OWNER, reply)).toBe(true);
    expect(canReadMessage(COLLEAGUE, reply)).toBe(false);
  });

  it("should let a person read an agent's reply to them without access to the replying agent", () => {
    const reply: MessageRef = { kind: "direct", authorOid: OWNER, authorAgent: TARGET, targetAgent: null, parentAuthorOid: COLLEAGUE };

    expect(canReadMessage(COLLEAGUE, reply)).toBe(true);
    expect(canReadMessage(ELSEWHERE, reply)).toBe(false);
  });

  it("should keep a conversation's thread from everyone but its owner", () => {
    const message: MessageRef = { kind: "direct", authorOid: OWNER, authorAgent: null, targetAgent: TARGET, parentAuthorOid: null };

    expect(canReadMessage(OWNER, message)).toBe(true);
    for (const [, oid] of EVERYONE_ELSE) {
      expect(canReadMessage(oid, message)).toBe(false);
    }
  });

  it("should not widen a targeted direct message to the author of the message it replies to", () => {
    const reply: MessageRef = {
      kind: "direct",
      authorOid: OWNER,
      authorAgent: { id: "agent-other", ownerOid: OWNER },
      targetAgent: TARGET,
      parentAuthorOid: COLLEAGUE
    };

    expect(canReadMessage(COLLEAGUE, reply)).toBe(false);
  });

  it("should refuse a direct message with neither target nor author agent to anyone but its author", () => {
    const orphan: MessageRef = { kind: "direct", authorOid: OWNER, authorAgent: null, targetAgent: null, parentAuthorOid: null };

    expect(canReadMessage(OWNER, orphan)).toBe(true);
    expect(canReadMessage(COLLEAGUE, orphan)).toBe(false);
  });

  // Nothing sends a direct between two owners' agents, but rows that do are still stored.
  it("should not let anyone but its author read what an agent sent to another owner's agent", () => {
    const sent: MessageRef = { kind: "direct", authorOid: OWNER, authorAgent: TARGET, targetAgent: agentOf(ELSEWHERE), parentAuthorOid: null };

    expect(canReadMessage(COLLEAGUE, sent)).toBe(false);
    expect(canReadMessage(OWNER, sent)).toBe(true);
  });
});

describe("replyRoute", () => {
  const replier = TARGET;

  it("should route a reply to the agent that sent the direct message when it has the same owner", () => {
    const sender: AgentRef = { id: "agent-other", ownerOid: OWNER };
    const received: MessageRef = { kind: "direct", authorOid: OWNER, authorAgent: sender, targetAgent: replier, parentAuthorOid: null };

    expect(replyRoute(replier, received)).toEqual({ to: "agent", target: sender });
  });

  it("should refuse a reply to a direct message when another owner's agent sent it", () => {
    const received: MessageRef = { kind: "direct", authorOid: ELSEWHERE, authorAgent: agentOf(ELSEWHERE), targetAgent: replier, parentAuthorOid: null };

    expect(replyRoute(replier, received)).toEqual({
      to: "nobody",
      reason: "a private reply to an agent of another owner is not allowed; post on the topic and tag that agent instead",
      status: 403
    });
  });

  it("should route a reply to a person's direct message into the replying agent's own thread", () => {
    const received: MessageRef = { kind: "direct", authorOid: OWNER, authorAgent: null, targetAgent: replier, parentAuthorOid: null };

    expect(replyRoute(replier, received)).toEqual({ to: "person" });
  });

  it("should refuse a reply to a direct message the agent did not receive", () => {
    const overheard: MessageRef = {
      kind: "direct",
      authorOid: COLLEAGUE,
      authorAgent: agentOf(COLLEAGUE),
      targetAgent: agentOf(ELSEWHERE),
      parentAuthorOid: null
    };

    expect(replyRoute(replier, overheard)).toMatchObject({ to: "nobody", status: 403 });
  });

  it("should refuse a reply to the agent's own message", () => {
    const own: MessageRef = { kind: "direct", authorOid: OWNER, authorAgent: replier, targetAgent: agentOf(ELSEWHERE), parentAuthorOid: null };

    expect(replyRoute(replier, own)).toMatchObject({ to: "nobody", status: 400 });
  });

  it("should route a private reply to a person's post into the replying agent's own thread, whoever they are", () => {
    const post: MessageRef = { kind: "post", authorOid: COLLEAGUE, authorAgent: null, targetAgent: null, parentAuthorOid: null };

    expect(replyRoute(replier, post)).toEqual({ to: "person" });
  });

  it("should route a private reply to another agent of the same owner's post to that agent", () => {
    const post: MessageRef = { kind: "post", authorOid: OWNER, authorAgent: agentOf(OWNER), targetAgent: null, parentAuthorOid: null };

    expect(replyRoute(replier, post)).toEqual({ to: "agent", target: agentOf(OWNER) });
  });

  it("should refuse a private reply to another owner's post and say to post and tag instead", () => {
    const post: MessageRef = { kind: "post", authorOid: ELSEWHERE, authorAgent: agentOf(ELSEWHERE), targetAgent: null, parentAuthorOid: null };

    expect(replyRoute(replier, post)).toEqual({
      to: "nobody",
      reason: "a private reply to another owner's post is not allowed; post on the topic and tag that agent instead",
      status: 403
    });
  });
});

/** A pod conversation's agent: the CFT Workspace, which no post may tag. */
const POD_CHAT_AGENT: AgentRef = { id: "agent-conversation", ownerOid: OWNER, ownerOnly: true };

/** A conversation of a session on the owner's own laptop: an ordinary agent, which a post may tag. */
const LOCAL_CHAT_AGENT: AgentRef = { id: "agent-local-conversation", ownerOid: OWNER, ownerOnly: false };

describe("an assistant conversation's agent", () => {
  it.each<[Role, boolean]>([
    ["owner", true],
    ["colleague", false]
  ])("should answer %s for the %s on every rule about a pod conversation's agent", (role, expected) => {
    expect(isOwner(ROLES[role], POD_CHAT_AGENT)).toBe(expected);
    expect(canViewTranscript(ROLES[role], POD_CHAT_AGENT)).toBe(expected);
    expect(canAgentMessageAgent(agentOf(ROLES[role]), POD_CHAT_AGENT)).toBe(expected);
  });

  // The agent of a session on a laptop is an ordinary agent: its owner's, like any other, and taggable.
  it.each<[Role, boolean]>([
    ["owner", true],
    ["colleague", false]
  ])("should answer %s for the %s on every rule about a local conversation's agent", (role, expected) => {
    expect(isOwner(ROLES[role], LOCAL_CHAT_AGENT)).toBe(expected);
    expect(canViewTranscript(ROLES[role], LOCAL_CHAT_AGENT)).toBe(expected);
  });

  it("should separate the two kinds only in what a post may tag", () => {
    expect(tagRefusal(null, POD_CHAT_AGENT)).toBe("not_taggable");
    expect(tagRefusal(null, LOCAL_CHAT_AGENT)).toBeUndefined();
  });
});

describe("isPodConversationAgent", () => {
  it.each<[string, string | null, string | null, boolean]>([
    ["a session on a laptop", null, null, false],
    ["a virtual agent's own pod session", null, "va-1", false],
    ["a pod conversation's agent", "chat-1", "va-1", true],
    ["a local conversation's agent", "chat-1", null, false]
  ])("should answer for %s from the row alone", (_label, assistantConversationId, virtualAgentId, expected) => {
    expect(isPodConversationAgent({ assistantConversationId, virtualAgentId })).toBe(expected);
  });
});

describe("canManageVirtualAgent", () => {
  // It acts with the owner's own GitHub, Azure and Atlassian sign-ins — managing it, searching Atlassian through it and
  // running a Welsh job on it alike — so nobody else may, and no share of a chat of theirs reaches it.
  it("should let a person make a virtual agent act as them when it is their own", () => {
    expect(canManageVirtualAgent(OWNER, { ownerOid: OWNER })).toBe(true);
  });

  it.each(EVERYONE_ELSE)("should refuse %s when they would make the owner's virtual agent act as the owner", (_label, actorOid) => {
    expect(canManageVirtualAgent(actorOid, { ownerOid: OWNER })).toBe(false);
  });
});

describe("canOpenVirtualAgentPort", () => {
  it.each<[boolean, Role]>([
    [true, "owner"],
    [false, "colleague"]
  ])("should answer %s when the %s opens a web server on the owner's virtual agent", (expected, role) => {
    expect(canOpenVirtualAgentPort(ROLES[role], { ownerOid: OWNER })).toBe(expected);
  });
});

describe("canLaunchTokenActForAgent", () => {
  it("should allow a launch token to act when its own virtual agent registered the agent", () => {
    expect(canLaunchTokenActForAgent("va-1", { virtualAgentId: "va-1" })).toBe(true);
  });

  it("should refuse a launch token when another virtual agent registered the agent", () => {
    expect(canLaunchTokenActForAgent("va-1", { virtualAgentId: "va-2" })).toBe(false);
  });

  it("should refuse a launch token when no virtual agent registered the agent, though its owner is the same", () => {
    expect(canLaunchTokenActForAgent("va-1", { virtualAgentId: null })).toBe(false);
  });
});

describe("canActAsVirtualAgent", () => {
  it("should allow a launch token when the routes are its own virtual agent's", () => {
    expect(canActAsVirtualAgent("va-1", "va-1")).toBe(true);
  });

  it("should refuse a launch token when the routes are another virtual agent's", () => {
    expect(canActAsVirtualAgent("va-1", "va-2")).toBe(false);
  });

  it("should refuse a caller when it has no launch token", () => {
    expect(canActAsVirtualAgent(undefined, "va-1")).toBe(false);
  });
});

describe("canUseCredentialRoutes", () => {
  it("should allow a caller when it holds a person's own token", () => {
    expect(canUseCredentialRoutes({})).toBe(true);
  });

  it("should refuse a caller when it holds a launch token", () => {
    expect(canUseCredentialRoutes({ virtualAgentId: "va-1" })).toBe(false);
  });
});

describe("canOwnerReadCredential", () => {
  it("should let the owner read their CLAUDE.md back when the page shows it for editing", () => {
    expect(canOwnerReadCredential("claude_md")).toBe(true);
  });

  it("should let the owner read their git identity back when the page shows it for editing", () => {
    expect(canOwnerReadCredential("git_identity")).toBe(true);
  });

  it.each(["github", "azure", "claude", "jenkins", "atlassian", "bedrock", "Bedrock", "claude-md", "git-identity", ""])(
    "should keep %j write-only when it is any other kind",
    (kind) => {
      expect(canOwnerReadCredential(kind)).toBe(false);
    }
  );
});

describe("canVirtualAgentStoreCredential", () => {
  it.each(["github", "azure", "claude", "jenkins", "atlassian"])(
    "should let a pod store its owner's %s when it is a credential the pod signs in for",
    (kind) => {
      expect(canVirtualAgentStoreCredential(kind)).toBe(true);
    }
  );

  it("should refuse a pod when it would change its owner's CLAUDE.md", () => {
    expect(canVirtualAgentStoreCredential("claude_md")).toBe(false);
  });

  it("should refuse a pod when it would change its owner's git identity", () => {
    expect(canVirtualAgentStoreCredential("git_identity")).toBe(false);
  });
});

describe("canLaunchTokenReadMessage", () => {
  const SESSIONS = ["va-session-1", "va-session-2"];
  const session: AgentRef = { id: "va-session-2", ownerOid: OWNER };
  const laptop: AgentRef = { id: "laptop", ownerOid: OWNER };
  const elsewhere: AgentRef = agentOf(ELSEWHERE);

  function direct(authorAgent: AgentRef | null, targetAgent: AgentRef | null): MessageRef {
    return { kind: "direct", authorOid: authorAgent?.ownerOid ?? OWNER, authorAgent, targetAgent, parentAuthorOid: null };
  }

  it("should allow a post when anyone may read it", () => {
    expect(canLaunchTokenReadMessage([], { kind: "post", authorOid: ELSEWHERE, authorAgent: elsewhere, targetAgent: null, parentAuthorOid: null })).toBe(true);
  });

  it.each([
    ["sent to one of its sessions by a person", direct(null, session)],
    ["sent to one of its sessions by the owner's other agent", direct(laptop, session)],
    ["sent by one of its sessions to the owner's other agent", direct(session, laptop)],
    ["a reply by one of its sessions into its own UI thread", direct(session, null)],
    ["sent to one of its sessions by another owner's agent", direct(elsewhere, session)],
    ["sent by one of its sessions to another owner's agent", direct(session, elsewhere)]
  ])("should allow a direct when it is %s", (_label, message) => {
    expect(canLaunchTokenReadMessage(SESSIONS, message)).toBe(true);
  });

  it.each([
    ["sent by the owner to their other agent", direct(null, laptop)],
    ["a reply by the owner's other agent into its own UI thread", direct(laptop, null)],
    ["sent by the owner's other agent to another owner's", direct(laptop, elsewhere)],
    ["sent to another owner's agent by a person", direct(null, elsewhere)]
  ])("should refuse a direct when it is %s", (_label, message) => {
    expect(canLaunchTokenReadMessage(SESSIONS, message)).toBe(false);
  });

  it("should refuse every direct when the virtual agent has no sessions yet", () => {
    expect(canLaunchTokenReadMessage([], direct(null, session))).toBe(false);
  });
});

describe("the upload rules", () => {
  const CONVERSATION = "conv-1";

  function upload(overrides: Partial<UploadRef> = {}): UploadRef {
    return { conversationId: CONVERSATION, ownerOid: OWNER, messageId: null, state: "pending", ...overrides };
  }

  describe("canWriteUpload", () => {
    it.each([["pending"], ["stored"]] as const)("should allow the owner to write an upload that is %s", (state) => {
      expect(canWriteUpload(OWNER, upload({ state }))).toBe(true);
    });

    it("should refuse anyone but the person who started it", () => {
      expect(canWriteUpload(COLLEAGUE, upload())).toBe(false);
      expect(canWriteUpload(ELSEWHERE, upload())).toBe(false);
    });

    it("should refuse an upload already attached to a message, since there is nothing left to write", () => {
      expect(canWriteUpload(OWNER, upload({ state: "stored", messageId: "41" }))).toBe(false);
    });

    it.each([["fetched"], ["expired"]] as const)("should refuse an upload that is %s", (state) => {
      expect(canWriteUpload(OWNER, upload({ state }))).toBe(false);
    });
  });

  describe("canAttachUpload", () => {
    it("should allow the owner to attach their own finished upload to its own conversation", () => {
      expect(canAttachUpload(OWNER, CONVERSATION, upload({ state: "stored" }))).toBe(true);
    });

    it("should refuse an upload of another conversation", () => {
      expect(canAttachUpload(OWNER, "conv-2", upload({ state: "stored" }))).toBe(false);
    });

    it("should refuse someone else's upload", () => {
      expect(canAttachUpload(ELSEWHERE, CONVERSATION, upload({ state: "stored" }))).toBe(false);
    });

    it("should refuse an upload that is still arriving", () => {
      expect(canAttachUpload(OWNER, CONVERSATION, upload({ state: "pending" }))).toBe(false);
    });

    it("should refuse an upload already on a message, so it is attached once", () => {
      expect(canAttachUpload(OWNER, CONVERSATION, upload({ state: "stored", messageId: "41" }))).toBe(false);
    });
  });

  describe("canSessionUseAttachment", () => {
    const attached = upload({ state: "stored", messageId: "41" });

    it("should let a conversation's session read a part of its own attachment", () => {
      expect(canSessionUseAttachment(CONVERSATION, attached, "part")).toBe(true);
    });

    it("should refuse an attachment of another conversation", () => {
      expect(canSessionUseAttachment("conv-2", attached, "part")).toBe(false);
    });

    it("should refuse an agent that is not a conversation's at all", () => {
      expect(canSessionUseAttachment(null, attached, "part")).toBe(false);
    });

    it("should refuse an upload that never reached a message", () => {
      expect(canSessionUseAttachment(CONVERSATION, upload({ state: "stored" }), "part")).toBe(false);
    });

    it.each([["pending"], ["fetched"], ["expired"]] as const)("should refuse reading a part when the upload is %s", (state) => {
      expect(canSessionUseAttachment(CONVERSATION, upload({ state, messageId: "41" }), "part")).toBe(false);
    });

    it.each([["stored"], ["fetched"]] as const)("should accept a fetched report when the upload is %s", (state) => {
      expect(canSessionUseAttachment(CONVERSATION, upload({ state, messageId: "41" }), "fetched")).toBe(true);
    });

    it.each([["pending"], ["expired"]] as const)("should refuse a fetched report when the upload is %s", (state) => {
      expect(canSessionUseAttachment(CONVERSATION, upload({ state, messageId: "41" }), "fetched")).toBe(false);
    });
  });

  describe("attachmentDownload", () => {
    const NOW = new Date("2026-10-21T12:00:00.000Z");
    const SOON = new Date("2026-10-21T14:00:00.000Z");
    const PASSED = new Date("2026-10-21T11:00:00.000Z");
    const sent = upload({ state: "fetched", messageId: "41" });

    it.each([["stored"], ["fetched"]] as const)("should let the owner download their own upload when it is %s", (state) => {
      expect(attachmentDownload(OWNER, upload({ state, messageId: "41" }), SOON, NOW)).toBe("ok");
    });

    it("should let the owner download an upload that never reached a message, since it is still their file", () => {
      expect(attachmentDownload(OWNER, upload({ state: "stored" }), SOON, NOW)).toBe("ok");
    });

    it.each(EVERYONE_ELSE)("should refuse %s, as though the upload did not exist", (_label, viewerOid) => {
      expect(attachmentDownload(viewerOid, sent, SOON, NOW)).toBe("not_yours");
    });

    it("should tell the owner the bytes are gone once the window has closed", () => {
      expect(attachmentDownload(OWNER, sent, PASSED, NOW)).toBe("not_held");
    });

    it("should refuse the instant the window closes, rather than at the instant after it", () => {
      expect(attachmentDownload(OWNER, sent, NOW, NOW)).toBe("not_held");
    });

    it("should refuse an expired upload even inside the window, which is a sweep that has already run", () => {
      expect(attachmentDownload(OWNER, upload({ state: "expired", messageId: "41" }), SOON, NOW)).toBe("not_held");
    });

    it("should refuse an upload still arriving, whose parts would make a file with holes in it", () => {
      expect(attachmentDownload(OWNER, upload({ state: "pending" }), SOON, NOW)).toBe("not_held");
    });

    it("should refuse someone else's expired upload as not theirs, saying nothing about its state", () => {
      expect(attachmentDownload(ELSEWHERE, upload({ state: "expired", messageId: "41" }), PASSED, NOW)).toBe("not_yours");
    });
  });

  describe("canRemoveUploadFromDisk", () => {
    it.each([["stored"], ["fetched"], ["expired"]] as const)("should let the owner clear a %s upload that reached a message", (state) => {
      expect(canRemoveUploadFromDisk(OWNER, upload({ state, messageId: "41" }))).toBe(true);
    });

    // A pod only ever fetches what was sent, so an upload still in a composer has no copy on its disk to clear.
    it("should refuse an upload that never reached a message, which no pod has a copy of", () => {
      expect(canRemoveUploadFromDisk(OWNER, upload({ state: "stored" }))).toBe(false);
    });

    it.each(EVERYONE_ELSE)("should refuse %s clearing the owner's file", (_label, oid) => {
      expect(canRemoveUploadFromDisk(oid, upload({ state: "fetched", messageId: "41" }))).toBe(false);
    });
  });
});

/**
 * The share rows are the only access anyone grants anyone in this application, so these are the rules that have to
 * hold: who is on the list, and that nothing but the list puts them there.
 */
describe("the conversation share rules", () => {
  const CONVERSATION: SharedConversationRef = { id: "conv-1", ownerOid: OWNER };
  const RECIPIENT = "oid-recipient";
  const SHARES: ConversationShare[] = [
    { conversationId: CONVERSATION.id, recipientOid: RECIPIENT },
    // A share of another conversation of the same owner, which must not carry over to this one.
    { conversationId: "conv-2", recipientOid: ELSEWHERE }
  ];

  describe("conversationAccess", () => {
    it("should answer owner when the viewer owns the conversation", () => {
      expect(conversationAccess(OWNER, CONVERSATION, SHARES)).toBe("owner");
    });

    it("should answer reader when the viewer is named in a share of that conversation", () => {
      expect(conversationAccess(RECIPIENT, CONVERSATION, SHARES)).toBe("reader");
    });

    it("should answer none when the viewer is named only in a share of another conversation", () => {
      expect(conversationAccess(ELSEWHERE, CONVERSATION, SHARES)).toBe("none");
    });

    it("should answer none when the conversation is shared with nobody", () => {
      expect(conversationAccess(RECIPIENT, CONVERSATION, [])).toBe("none");
    });

    it.each(EVERYONE_ELSE)("should answer none for %s, since a share is the only thing that names anyone", (_label, viewerOid) => {
      expect(conversationAccess(viewerOid, CONVERSATION, SHARES)).toBe("none");
    });
  });

  describe("canReadDeck", () => {
    it("should let the owner and a share's recipient read the deck when the share names them", () => {
      expect(canReadDeck(conversationAccess(OWNER, CONVERSATION, SHARES))).toBe(true);
      expect(canReadDeck(conversationAccess(RECIPIENT, CONVERSATION, SHARES))).toBe(true);
    });

    it("should let someone offered a fork read the deck when the offer is in the rows the rule is given", () => {
      const offers: ConversationShare[] = [{ conversationId: CONVERSATION.id, recipientOid: ELSEWHERE }];
      expect(canReadDeck(conversationAccess(ELSEWHERE, CONVERSATION, offers))).toBe(true);
    });

    it.each(EVERYONE_ELSE)("should refuse %s the deck, its pictures and its .pptx", (_label, viewerOid) => {
      expect(canReadDeck(conversationAccess(viewerOid, CONVERSATION, SHARES))).toBe(false);
    });

    it("should refuse the deck when the access answered is none", () => {
      expect(canReadDeck("none")).toBe(false);
    });
  });

  describe("canChangeDeck", () => {
    it("should let the owner restore a version or start a build", () => {
      expect(canChangeDeck(conversationAccess(OWNER, CONVERSATION, SHARES))).toBe(true);
    });

    it("should refuse a share's recipient when the share lets them read the deck", () => {
      const access = conversationAccess(RECIPIENT, CONVERSATION, SHARES);
      expect(canReadDeck(access)).toBe(true);
      expect(canChangeDeck(access)).toBe(false);
    });

    it("should refuse someone offered a fork when the offer lets them read the deck", () => {
      const offers: ConversationShare[] = [{ conversationId: CONVERSATION.id, recipientOid: ELSEWHERE }];
      expect(canChangeDeck(conversationAccess(ELSEWHERE, CONVERSATION, offers))).toBe(false);
    });

    it.each(EVERYONE_ELSE)("should refuse %s a restore and a build", (_label, viewerOid) => {
      expect(canChangeDeck(conversationAccess(viewerOid, CONVERSATION, SHARES))).toBe(false);
    });
  });

  describe("a share page", () => {
    it.each([
      ["its owner", OWNER],
      ["someone named in a share of it", RECIPIENT]
    ])("should let %s read the share page when they own or were named in it", (_label, viewerOid) => {
      expect(conversationAccess(viewerOid, CONVERSATION, SHARES)).not.toBe("none");
    });

    // The one that matters: holding the link is not being on the list, so anyone handed it reads nothing. The rule
    // takes no link, token or secret at all, which is why there is nothing a link alone could satisfy.
    it.each(EVERYONE_ELSE)("should refuse %s, however they came by the address", (_label, viewerOid) => {
      expect(conversationAccess(viewerOid, CONVERSATION, SHARES)).toBe("none");
    });

    it("should refuse everyone but the owner while the conversation is shared with nobody", () => {
      expect(conversationAccess(OWNER, CONVERSATION, [])).toBe("owner");
      for (const viewerOid of [RECIPIENT, COLLEAGUE, ELSEWHERE]) {
        expect(conversationAccess(viewerOid, CONVERSATION, [])).toBe("none");
      }
    });
  });

  // A share is of the conversation, never of its agent, so everything decided about the agent still answers for a
  // recipient exactly as it does for a stranger: the UI stream's watch, the agent API's routes and the rosters.
  describe("what a share does not widen", () => {
    const agent: AgentRef = { id: "conversation-agent", ownerOid: OWNER, ownerOnly: true };

    it.each([
      ["see, message or be offered the skills of the conversation's agent", isOwner],
      ["read its transcript", canViewTranscript]
    ])("should not let a share recipient %s", (_label, rule) => {
      expect(rule(RECIPIENT, agent)).toBe(false);
    });

    it("should still let the owner do all of it", () => {
      for (const rule of [isOwner, canViewTranscript]) {
        expect(rule(OWNER, agent)).toBe(true);
      }
    });

    it.each([
      ["a recipient of it", RECIPIENT],
      ["a colleague", COLLEAGUE],
      ["another owner", ELSEWHERE]
    ])("should not let %s see or change who the conversation is shared with when they do not own it", (_label, actorOid) => {
      expect(isOwner(actorOid, CONVERSATION)).toBe(false);
    });
  });

  describe("canShareConversationWith", () => {
    it("should let the owner share with someone the hub knows", () => {
      expect(canShareConversationWith(OWNER, CONVERSATION, RECIPIENT, true)).toBe(true);
    });

    it("should refuse someone who has never used the hub", () => {
      expect(canShareConversationWith(OWNER, CONVERSATION, RECIPIENT, false)).toBe(false);
    });

    it("should refuse sharing a conversation with its own owner", () => {
      expect(canShareConversationWith(OWNER, CONVERSATION, OWNER, true)).toBe(false);
    });

    it.each([
      ["a recipient", RECIPIENT],
      ["a colleague", COLLEAGUE]
    ])("should refuse %s sharing someone else's conversation", (_label, actorOid) => {
      expect(canShareConversationWith(actorOid, CONVERSATION, ELSEWHERE, true)).toBe(false);
    });
  });

  describe("canForkConversation", () => {
    const FORKER = "oid-forker";
    const FORKS: ConversationShare[] = [
      { conversationId: CONVERSATION.id, recipientOid: FORKER },
      { conversationId: "conv-2", recipientOid: ELSEWHERE }
    ];

    it("should allow the person named when the owner offered them the conversation to fork", () => {
      expect(canForkConversation(FORKER, CONVERSATION, FORKS)).toBe(true);
    });

    it("should refuse the owner when they look at their own conversation, which is already theirs", () => {
      expect(canForkConversation(OWNER, CONVERSATION, [...FORKS, { conversationId: CONVERSATION.id, recipientOid: OWNER }])).toBe(false);
    });

    it("should refuse a reader when they were shared the chat to read but not offered it to fork", () => {
      // The read shares are not the fork rows; a caller handing them in by mistake still finds no fork for a reader.
      expect(canForkConversation(RECIPIENT, CONVERSATION, FORKS)).toBe(false);
    });

    it("should refuse someone when they were offered only another conversation of the same owner", () => {
      expect(canForkConversation(ELSEWHERE, CONVERSATION, FORKS)).toBe(false);
    });

    it("should refuse a colleague when no fork names them", () => {
      expect(canForkConversation(COLLEAGUE, CONVERSATION, FORKS)).toBe(false);
    });

    it("should refuse the person once offered when the offer has been withdrawn", () => {
      expect(canForkConversation(FORKER, CONVERSATION, [])).toBe(false);
    });

    it("should let the person offered read the share page when their fork row is read beside the shares", () => {
      expect(conversationAccess(FORKER, CONVERSATION, [...SHARES, ...FORKS])).toBe("reader");
    });

    it("should not let the person offered reach the conversation's agent when they hold a fork of it", () => {
      const agent: AgentRef = { id: "conversation-agent", ownerOid: OWNER, ownerOnly: true };
      for (const rule of [isOwner, canViewTranscript]) {
        expect(rule(FORKER, agent)).toBe(false);
      }
    });
  });
});

describe("the people lookup rules", () => {
  describe("peopleLookup", () => {
    it("should answer a query of the shortest length it accepts", () => {
      expect(peopleLookup("no")).toEqual({ ok: true, query: "no", limit: MAX_PEOPLE_SUGGESTIONS });
    });

    it("should trim the query, so the spaces around a name do not count towards its length", () => {
      expect(peopleLookup("  norton  ")).toEqual({ ok: true, query: "norton", limit: MAX_PEOPLE_SUGGESTIONS });
    });

    it.each([[""], [" "], ["n"], ["  n "]])("should refuse %p, which is too little to match anyone against", (raw) => {
      expect(peopleLookup(raw)).toEqual({ ok: false });
    });

    it("should hold the shortest query to two characters, so one letter does not answer with the hub", () => {
      expect(MIN_PEOPLE_QUERY).toBe(2);
    });

    it("should keep one answer short enough not to be a list", () => {
      expect(MAX_PEOPLE_SUGGESTIONS).toBe(8);
    });
  });

  describe("agentLookup", () => {
    it("should take the same bounds as the people lookup when the agent picker is searched", () => {
      expect(agentLookup("  pcs  ")).toEqual({ ok: true, query: "pcs", limit: MAX_PEOPLE_SUGGESTIONS });
      expect(agentLookup("p")).toEqual({ ok: false });
    });
  });

  describe("canSuggestPerson", () => {
    it("should offer anyone else the hub knows", () => {
      expect(canSuggestPerson(OWNER, { oid: COLLEAGUE })).toBe(true);
    });

    it("should not offer the viewer themselves", () => {
      expect(canSuggestPerson(OWNER, { oid: OWNER })).toBe(false);
    });
  });
});

describe("tagRefusal", () => {
  it("should let a post tag any agent, of any owner", () => {
    expect(tagRefusal(null, TARGET)).toBeUndefined();
    expect(tagRefusal("agent-of-oid-elsewhere", TARGET)).toBeUndefined();
    expect(tagRefusal(null, agentOf(ELSEWHERE))).toBeUndefined();
  });

  it("should let a post tag a session on somebody's laptop, which is an ordinary agent", () => {
    expect(tagRefusal(null, LOCAL_CHAT_AGENT)).toBeUndefined();
  });

  it("should refuse a pod conversation's agent, its owner's own post included", () => {
    expect(tagRefusal(null, POD_CHAT_AGENT)).toBe("not_taggable");
    expect(tagRefusal("agent-of-oid-owner", POD_CHAT_AGENT)).toBe("not_taggable");
  });

  it("should refuse an agent tagging itself, and not the same agent in a person's post", () => {
    expect(tagRefusal(TARGET.id, TARGET)).toBe("itself");
    expect(tagRefusal(null, TARGET)).toBeUndefined();
  });
});
