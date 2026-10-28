import { describe, expect, it } from "vitest";
import {
  type AgentRef,
  agentAccess,
  attachmentDownload,
  type ConversationShare,
  canActAsVirtualAgent,
  canAgentMessageAgent,
  canAttachUpload,
  canForkConversation,
  canGrant,
  canLaunchTokenActForAgent,
  canLaunchTokenReadMessage,
  canLookUpAtlassian,
  canManageConversationShares,
  canManageCredential,
  canManageExportDefaults,
  canManageGrants,
  canManageTemplate,
  canManageUploadsOnDisk,
  canManageVirtualAgent,
  canOwnerReadCredential,
  canPersonMessageAgent,
  canReadMessage,
  canRemoveUploadFromDisk,
  canSeeAgentSkills,
  canSeeAssistantMemory,
  canSessionUseAttachment,
  canShareConversationWith,
  canStopAssistantAnswer,
  canSuggestPerson,
  canUseCredentialRoutes,
  canViewAgent,
  canViewConversation,
  canViewSharedConversation,
  canViewTranscript,
  canViewVirtualAgent,
  canVirtualAgentStoreCredential,
  canWriteUpload,
  conversationAccess,
  type Grant,
  grantLevel,
  MAX_PEOPLE_SUGGESTIONS,
  type MessageRef,
  MIN_PEOPLE_QUERY,
  peopleLookup,
  replyRoute,
  type SharedConversationRef,
  type UploadRef
} from "./rules.ts";

const OWNER = "oid-owner";
const READER = "oid-reader";
const WRITER = "oid-writer";
const STRANGER = "oid-stranger";
const ELSEWHERE = "oid-elsewhere";

const GRANTS: Grant[] = [
  { ownerOid: OWNER, granteeOid: READER, level: "read" },
  { ownerOid: OWNER, granteeOid: WRITER, level: "write" },
  // A grant from someone else must never count towards the owner's agents.
  { ownerOid: ELSEWHERE, granteeOid: STRANGER, level: "write" }
];

const TARGET: AgentRef = { id: "agent-owned", ownerOid: OWNER };

function agentOf(ownerOid: string): AgentRef {
  return { id: `agent-of-${ownerOid}`, ownerOid };
}

type Role = "owner" | "read grantee" | "write grantee" | "stranger";

const ROLES: Record<Role, string> = {
  owner: OWNER,
  "read grantee": READER,
  "write grantee": WRITER,
  stranger: STRANGER
};

interface Expectation {
  viewAgent: boolean;
  viewTranscript: boolean;
  messageAsPerson: boolean;
  seeSkills: boolean;
  messageAsAgent: boolean;
  readDirect: boolean;
  manageGrants: boolean;
}

const MATRIX: Record<Role, Expectation> = {
  owner: { viewAgent: true, viewTranscript: true, messageAsPerson: true, seeSkills: true, messageAsAgent: true, readDirect: true, manageGrants: true },
  "read grantee": {
    viewAgent: true,
    viewTranscript: true,
    messageAsPerson: false,
    seeSkills: false,
    messageAsAgent: false,
    readDirect: true,
    manageGrants: false
  },
  "write grantee": {
    viewAgent: true,
    viewTranscript: true,
    messageAsPerson: true,
    seeSkills: true,
    messageAsAgent: true,
    readDirect: true,
    manageGrants: false
  },
  stranger: { viewAgent: false, viewTranscript: false, messageAsPerson: false, seeSkills: false, messageAsAgent: false, readDirect: false, manageGrants: false }
};

/** A direct message from a third party's agent to the owner's agent. */
const DIRECT_TO_TARGET: MessageRef = { kind: "direct", authorOid: ELSEWHERE, authorAgent: agentOf(ELSEWHERE), targetAgent: TARGET, parentAuthorOid: null };

describe.each(Object.entries(MATRIX) as [Role, Expectation][])("access for the %s", (role, expected) => {
  const oid = ROLES[role];

  it(`should ${expected.viewAgent ? "" : "not "}show the agent when the viewer is the ${role}`, () => {
    expect(canViewAgent(oid, TARGET, GRANTS)).toBe(expected.viewAgent);
  });

  it(`should ${expected.viewTranscript ? "" : "not "}show the agent's transcript when the viewer is the ${role}`, () => {
    expect(canViewTranscript(oid, TARGET, GRANTS)).toBe(expected.viewTranscript);
  });

  it(`should ${expected.messageAsPerson ? "" : "not "}let a person message the agent when they are the ${role}`, () => {
    expect(canPersonMessageAgent(oid, TARGET, GRANTS)).toBe(expected.messageAsPerson);
  });

  it(`should ${expected.seeSkills ? "" : "not "}offer the agent's skills when the viewer is the ${role}`, () => {
    expect(canSeeAgentSkills(oid, TARGET, GRANTS)).toBe(expected.seeSkills);
  });

  it(`should ${expected.messageAsAgent ? "" : "not "}let an agent message the agent when its owner is the ${role}`, () => {
    expect(canAgentMessageAgent(agentOf(oid), TARGET, GRANTS)).toBe(expected.messageAsAgent);
  });

  it(`should ${expected.readDirect ? "" : "not "}let the ${role} read a direct message to the agent`, () => {
    expect(canReadMessage(oid, DIRECT_TO_TARGET, GRANTS)).toBe(expected.readDirect);
  });

  it(`should ${expected.manageGrants ? "" : "not "}let the ${role} change the owner's grants`, () => {
    expect(canManageGrants(oid, OWNER)).toBe(expected.manageGrants);
  });

  it(`should ${expected.manageGrants ? "" : "not "}let the ${role} grant a known person access`, () => {
    expect(canGrant(oid, OWNER, ELSEWHERE, true)).toBe(expected.manageGrants);
  });

  it(`should let the ${role} read any post`, () => {
    expect(canReadMessage(oid, { kind: "post", authorOid: ELSEWHERE, authorAgent: agentOf(ELSEWHERE), targetAgent: null, parentAuthorOid: null }, [])).toBe(
      true
    );
  });

  it(`should ${expected.seeSkills ? "" : "not "}offer the agent's skills when the viewer is the ${role}`, () => {
    expect(canSeeAgentSkills(oid, TARGET, GRANTS)).toBe(expected.seeSkills);
  });

  it(`should ${expected.messageAsAgent ? "" : "not "}route a private reply to the owner's post when the replying agent's owner is the ${role}`, () => {
    const post: MessageRef = { kind: "post", authorOid: OWNER, authorAgent: TARGET, targetAgent: null, parentAuthorOid: null };
    const route = replyRoute(agentOf(oid), post, GRANTS);
    expect(route.to).toBe(expected.messageAsAgent ? "agent" : "nobody");
  });
});

describe("grantLevel", () => {
  it("should report nothing when there is no grant", () => {
    expect(grantLevel(GRANTS, OWNER, STRANGER)).toBeUndefined();
  });

  it("should prefer write when duplicate rows disagree", () => {
    const grants: Grant[] = [
      { ownerOid: OWNER, granteeOid: READER, level: "read" },
      { ownerOid: OWNER, granteeOid: READER, level: "write" }
    ];
    expect(grantLevel(grants, OWNER, READER)).toBe("write");
  });

  it("should not read a grant in the reverse direction", () => {
    expect(grantLevel(GRANTS, WRITER, OWNER)).toBeUndefined();
  });
});

describe("canGrant", () => {
  it("should refuse a grantee the hub has never seen", () => {
    expect(canGrant(OWNER, OWNER, "oid-unknown", false)).toBe(false);
  });

  it("should refuse a grant from an owner to themself", () => {
    expect(canGrant(OWNER, OWNER, OWNER, true)).toBe(false);
  });
});

describe("canReadMessage", () => {
  it("should let the sender read their own direct message when they cannot see the target", () => {
    expect(canReadMessage(ELSEWHERE, DIRECT_TO_TARGET, [])).toBe(true);
  });

  it("should put a reply to a person in the replying agent's thread when it has no target", () => {
    const reply: MessageRef = { kind: "direct", authorOid: OWNER, authorAgent: TARGET, targetAgent: null, parentAuthorOid: null };

    expect(canReadMessage(READER, reply, GRANTS)).toBe(true);
    expect(canReadMessage(STRANGER, reply, GRANTS)).toBe(false);
  });

  it("should let a person read an agent's reply to them without access to the replying agent", () => {
    const reply: MessageRef = { kind: "direct", authorOid: OWNER, authorAgent: TARGET, targetAgent: null, parentAuthorOid: STRANGER };

    expect(canReadMessage(STRANGER, reply, GRANTS)).toBe(true);
    expect(canReadMessage(ELSEWHERE, reply, GRANTS)).toBe(false);
  });

  it("should not widen a targeted direct message to the author of the message it replies to", () => {
    const reply: MessageRef = { kind: "direct", authorOid: ELSEWHERE, authorAgent: agentOf(ELSEWHERE), targetAgent: TARGET, parentAuthorOid: STRANGER };

    expect(canReadMessage(STRANGER, reply, GRANTS)).toBe(false);
  });

  it("should refuse a direct message with neither target nor author agent to anyone but its author", () => {
    const orphan: MessageRef = { kind: "direct", authorOid: OWNER, authorAgent: null, targetAgent: null, parentAuthorOid: null };

    expect(canReadMessage(OWNER, orphan, GRANTS)).toBe(true);
    expect(canReadMessage(WRITER, orphan, GRANTS)).toBe(false);
  });

  it("should not let the author agent's grantees read what it sent to someone else's agent", () => {
    const sent: MessageRef = { kind: "direct", authorOid: OWNER, authorAgent: TARGET, targetAgent: agentOf(ELSEWHERE), parentAuthorOid: null };

    expect(canReadMessage(READER, sent, GRANTS)).toBe(false);
  });
});

describe("replyRoute", () => {
  const replier = TARGET;

  it("should route a reply to the agent that sent the direct message, whatever the grants", () => {
    const received: MessageRef = { kind: "direct", authorOid: STRANGER, authorAgent: agentOf(STRANGER), targetAgent: replier, parentAuthorOid: null };

    expect(replyRoute(replier, received, [])).toEqual({ to: "agent", target: agentOf(STRANGER) });
  });

  it("should route a reply to a person's direct message into the replying agent's own thread", () => {
    const received: MessageRef = { kind: "direct", authorOid: WRITER, authorAgent: null, targetAgent: replier, parentAuthorOid: null };

    expect(replyRoute(replier, received, GRANTS)).toEqual({ to: "person" });
  });

  it("should refuse a reply to a direct message the agent did not receive", () => {
    const overheard: MessageRef = {
      kind: "direct",
      authorOid: STRANGER,
      authorAgent: agentOf(STRANGER),
      targetAgent: agentOf(ELSEWHERE),
      parentAuthorOid: null
    };

    expect(replyRoute(replier, overheard, GRANTS)).toMatchObject({ to: "nobody", status: 403 });
  });

  it("should refuse a reply to the agent's own message", () => {
    const own: MessageRef = { kind: "direct", authorOid: OWNER, authorAgent: replier, targetAgent: agentOf(ELSEWHERE), parentAuthorOid: null };

    expect(replyRoute(replier, own, GRANTS)).toMatchObject({ to: "nobody", status: 400 });
  });

  it("should route a private reply to a person's post into the replying agent's own thread, whatever the grants", () => {
    const post: MessageRef = { kind: "post", authorOid: STRANGER, authorAgent: null, targetAgent: null, parentAuthorOid: null };

    expect(replyRoute(replier, post, [])).toEqual({ to: "person" });
  });
});

describe("agentAccess", () => {
  it.each<[Role, ReturnType<typeof agentAccess>]>([
    ["owner", "owner"],
    ["read grantee", "read"],
    ["write grantee", "write"],
    ["stranger", "none"]
  ])("should report the %s as %s when they look at the agent", (role, access) => {
    expect(agentAccess(ROLES[role], TARGET, GRANTS)).toBe(access);
  });
});

describe("an assistant conversation's agent", () => {
  const CONVERSATION: AgentRef = { id: "agent-conversation", ownerOid: OWNER, ownerOnly: true };

  it.each<[Role, ReturnType<typeof agentAccess>]>([
    ["owner", "owner"],
    ["read grantee", "none"],
    ["write grantee", "none"],
    ["stranger", "none"]
  ])("should give the %s %s access when the agent is owner-only, whatever their grants", (role, access) => {
    expect(agentAccess(ROLES[role], CONVERSATION, GRANTS)).toBe(access);
  });

  it.each<[boolean, Role]>([
    [true, "owner"],
    [false, "read grantee"],
    [false, "write grantee"]
  ])("should answer %s when the %s views, reads or messages an owner-only agent", (expected, role) => {
    expect(canViewAgent(ROLES[role], CONVERSATION, GRANTS)).toBe(expected);
    expect(canViewTranscript(ROLES[role], CONVERSATION, GRANTS)).toBe(expected);
    expect(canPersonMessageAgent(ROLES[role], CONVERSATION, GRANTS)).toBe(expected);
    expect(canSeeAgentSkills(ROLES[role], CONVERSATION, GRANTS)).toBe(expected);
  });

  it("should not let a write grantee's agent message an owner-only agent when it holds the grant", () => {
    expect(canAgentMessageAgent(agentOf(WRITER), CONVERSATION, GRANTS)).toBe(false);
    expect(canAgentMessageAgent(agentOf(OWNER), CONVERSATION, GRANTS)).toBe(true);
  });
});

describe("canManageCredential", () => {
  it.each<[boolean, Role]>([
    [true, "owner"],
    [false, "read grantee"],
    [false, "write grantee"],
    [false, "stranger"]
  ])("should answer %s when the %s manages the owner's credentials", (expected, role) => {
    expect(canManageCredential(ROLES[role], OWNER)).toBe(expected);
  });
});

describe("canManageTemplate", () => {
  // Reading is the same decision as writing, and no grant reaches a prompt somebody wrote for themselves.
  it.each<[boolean, Role]>([
    [true, "owner"],
    [false, "read grantee"],
    [false, "write grantee"],
    [false, "stranger"]
  ])("should answer %s when the %s reads or changes the owner's templates", (expected, role) => {
    expect(canManageTemplate(ROLES[role], OWNER)).toBe(expected);
  });
});

describe("canManageVirtualAgent", () => {
  it.each<[boolean, Role]>([
    [true, "owner"],
    [false, "read grantee"],
    [false, "write grantee"],
    [false, "stranger"]
  ])("should answer %s when the %s manages the owner's virtual agent", (expected, role) => {
    expect(canManageVirtualAgent(ROLES[role], { id: "va-1", ownerOid: OWNER })).toBe(expected);
  });
});

describe("canViewVirtualAgent", () => {
  it.each<[boolean, Role]>([
    [true, "owner"],
    [true, "read grantee"],
    [true, "write grantee"],
    [false, "stranger"]
  ])("should answer %s when the %s views the owner's virtual agent", (expected, role) => {
    expect(canViewVirtualAgent(ROLES[role], { id: "va-1", ownerOid: OWNER }, GRANTS)).toBe(expected);
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
  it("should let the owner read their key back when it is an Amazon Bedrock API key", () => {
    expect(canOwnerReadCredential("bedrock")).toBe(true);
  });

  it("should let the owner read their CLAUDE.md back when the page shows it for editing", () => {
    expect(canOwnerReadCredential("claude_md")).toBe(true);
  });

  it("should let the owner read their git identity back when the page shows it for editing", () => {
    expect(canOwnerReadCredential("git_identity")).toBe(true);
  });

  it.each([
    "github",
    "azure",
    "claude",
    "jenkins",
    "atlassian",
    "Bedrock",
    "claude-md",
    "git-identity",
    ""
  ])("should keep %j write-only when it is any other kind", (kind) => {
    expect(canOwnerReadCredential(kind)).toBe(false);
  });
});

describe("canVirtualAgentStoreCredential", () => {
  it.each([
    "github",
    "azure",
    "claude",
    "bedrock",
    "jenkins",
    "atlassian"
  ])("should let a pod store its owner's %s when it is a credential the pod signs in for", (kind) => {
    expect(canVirtualAgentStoreCredential(kind)).toBe(true);
  });

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
  const elsewhere: AgentRef = agentOf(STRANGER);

  function direct(authorAgent: AgentRef | null, targetAgent: AgentRef | null): MessageRef {
    return { kind: "direct", authorOid: authorAgent?.ownerOid ?? OWNER, authorAgent, targetAgent, parentAuthorOid: null };
  }

  it("should allow a post when anyone may read it", () => {
    expect(canLaunchTokenReadMessage([], { kind: "post", authorOid: STRANGER, authorAgent: elsewhere, targetAgent: null, parentAuthorOid: null })).toBe(true);
  });

  it.each([
    ["sent to one of its sessions by a person", direct(null, session)],
    ["sent to one of its sessions by another agent", direct(elsewhere, session)],
    ["sent by one of its sessions to another agent", direct(session, elsewhere)],
    ["a reply by one of its sessions into its own UI thread", direct(session, null)]
  ])("should allow a direct when it is %s", (_label, message) => {
    expect(canLaunchTokenReadMessage(SESSIONS, message)).toBe(true);
  });

  it.each([
    ["sent by the owner to their other agent", direct(null, laptop)],
    ["sent by the owner's other agent to someone else's", direct(laptop, elsewhere)],
    ["a reply by the owner's other agent into its own UI thread", direct(laptop, null)],
    ["sent to someone else's agent by a person", direct(null, elsewhere)]
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

    it("should refuse anyone but the person who started it, grant or no grant", () => {
      expect(canWriteUpload(WRITER, upload())).toBe(false);
      expect(canWriteUpload(STRANGER, upload())).toBe(false);
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
      expect(canAttachUpload(STRANGER, CONVERSATION, upload({ state: "stored" }))).toBe(false);
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

    it("should refuse anyone but the owner, grant or no grant, as though the upload did not exist", () => {
      expect(attachmentDownload(WRITER, sent, SOON, NOW)).toBe("not_yours");
      expect(attachmentDownload(READER, sent, SOON, NOW)).toBe("not_yours");
      expect(attachmentDownload(STRANGER, sent, SOON, NOW)).toBe("not_yours");
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
      expect(attachmentDownload(STRANGER, upload({ state: "expired", messageId: "41" }), PASSED, NOW)).toBe("not_yours");
    });
  });

  describe("canManageUploadsOnDisk", () => {
    it("should let a person see and clear what is on their own assistant's disk", () => {
      expect(canManageUploadsOnDisk(OWNER, OWNER)).toBe(true);
    });

    // A grant is over sessions a person chose to share, and what is on their assistant's volume is neither a session
    // nor something they shared, so this rule takes no grants at all rather than some it would ignore.
    it.each([
      ["writer", WRITER],
      ["reader", READER],
      ["stranger", STRANGER]
    ] as const)("should refuse a %s, however much access they hold over that person's agents", (_role, oid) => {
      expect(canManageUploadsOnDisk(oid, OWNER)).toBe(false);
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

    it.each([
      ["writer", WRITER],
      ["reader", READER],
      ["stranger", STRANGER]
    ] as const)("should refuse a %s clearing the owner's file", (_role, oid) => {
      expect(canRemoveUploadFromDisk(oid, upload({ state: "fetched", messageId: "41" }))).toBe(false);
    });
  });

  describe("canSeeAssistantMemory", () => {
    it("should let a person see what their own assistant reports about its memory", () => {
      expect(canSeeAssistantMemory(OWNER, OWNER)).toBe(true);
    });

    // As with the files on its disk, a grant is over sessions a person chose to share; how much memory their
    // assistant is using is neither.
    it.each([
      ["writer", WRITER],
      ["reader", READER],
      ["stranger", STRANGER]
    ] as const)("should refuse a %s, however much access they hold over that person's agents", (_role, oid) => {
      expect(canSeeAssistantMemory(oid, OWNER)).toBe(false);
    });
  });

  describe("conversations", () => {
    it("should let a person see their own chat", () => {
      expect(canViewConversation("alice", { ownerOid: "alice" })).toBe(true);
    });

    it("should refuse someone else's chat", () => {
      expect(canViewConversation("bob", { ownerOid: "alice" })).toBe(false);
    });

    // A grant covers every agent its owner has, and a chat's session agent is one of them. The chat is still nobody
    // else's, which is why this rule takes no grants at all rather than being handed some it would ignore.
    it("should refuse someone else's chat however much access they hold over that person's agents", () => {
      const write: Grant[] = [{ ownerOid: "alice", granteeOid: "bob", level: "write" }];

      expect(canViewAgent("bob", { id: "a1", ownerOid: "alice" }, write)).toBe(true);
      expect(canViewConversation("bob", { ownerOid: "alice" })).toBe(false);
    });

    // A `write` grantee can message any other agent of this owner's, so it is the one worth naming: a conversation's
    // agent is the owner's alone, and interrupting its turn is further still than sending it something.
    it.each<[boolean, Role]>([
      [true, "owner"],
      [false, "read grantee"],
      [false, "write grantee"],
      [false, "stranger"]
    ])("should answer %s when the %s stops the answer in the owner's chat", (expected, role) => {
      expect(canStopAssistantAnswer(ROLES[role], { ownerOid: OWNER })).toBe(expected);
    });
  });
});

describe("the conversation share rules", () => {
  const CONVERSATION: SharedConversationRef = { id: "conv-1", ownerOid: OWNER };
  const RECIPIENT = "oid-recipient";
  const SHARES: ConversationShare[] = [
    { conversationId: CONVERSATION.id, recipientOid: RECIPIENT },
    // A share of another conversation of the same owner, which must not carry over to this one.
    { conversationId: "conv-2", recipientOid: STRANGER }
  ];

  describe("conversationAccess", () => {
    it("should answer owner when the viewer owns the conversation", () => {
      expect(conversationAccess(OWNER, CONVERSATION, SHARES)).toBe("owner");
    });

    it("should answer reader when the viewer is named in a share of that conversation", () => {
      expect(conversationAccess(RECIPIENT, CONVERSATION, SHARES)).toBe("reader");
    });

    it("should answer none when the viewer is named only in a share of another conversation", () => {
      expect(conversationAccess(STRANGER, CONVERSATION, SHARES)).toBe("none");
    });

    it("should answer none when the conversation is shared with nobody", () => {
      expect(conversationAccess(RECIPIENT, CONVERSATION, [])).toBe("none");
    });

    it.each([
      ["a read grantee of the owner's agents", READER],
      ["a write grantee of the owner's agents", WRITER]
    ])("should answer none for %s, since no agent grant reaches a conversation", (_label, viewerOid) => {
      expect(conversationAccess(viewerOid, CONVERSATION, SHARES)).toBe("none");
    });
  });

  describe("canViewSharedConversation", () => {
    it.each([
      ["its owner", OWNER],
      ["someone named in a share of it", RECIPIENT]
    ])("should allow %s", (_label, viewerOid) => {
      expect(canViewSharedConversation(viewerOid, CONVERSATION, SHARES)).toBe(true);
    });

    // The one that matters: holding the link is not being on the list, so a stranger handed it reads nothing. The
    // rule takes no link, token or secret at all, which is why there is nothing a link alone could satisfy.
    it.each([
      ["a stranger", STRANGER],
      ["a read grantee of the owner's agents", READER],
      ["a write grantee of the owner's agents", WRITER]
    ])("should refuse %s, however they came by the address", (_label, viewerOid) => {
      expect(canViewSharedConversation(viewerOid, CONVERSATION, SHARES)).toBe(false);
    });

    it("should refuse everyone but the owner while the conversation is shared with nobody", () => {
      expect(canViewSharedConversation(OWNER, CONVERSATION, [])).toBe(true);
      for (const viewerOid of [RECIPIENT, READER, WRITER, STRANGER]) {
        expect(canViewSharedConversation(viewerOid, CONVERSATION, [])).toBe(false);
      }
    });
  });

  // A share is of the conversation, never of its agent, so everything decided about the agent still answers for a
  // recipient exactly as it does for a stranger: the UI stream's watch, the agent API's routes and the rosters.
  describe("what a share does not widen", () => {
    const agent: AgentRef = { id: "conversation-agent", ownerOid: OWNER, ownerOnly: true };
    const asGrants: Grant[] = [...GRANTS, { ownerOid: OWNER, granteeOid: RECIPIENT, level: "write" }];

    it.each([
      ["see the conversation's agent", canViewAgent],
      ["read its transcript", canViewTranscript],
      ["message it", canPersonMessageAgent],
      ["see the skills it offers", canSeeAgentSkills]
    ])("should not let a share recipient %s", (_label, rule) => {
      expect(rule(RECIPIENT, agent, [])).toBe(false);
      // Not even with a grant over the owner's agents on top, which is what `ownerOnly` is for.
      expect(rule(RECIPIENT, agent, asGrants)).toBe(false);
    });

    it("should still let the owner do all of it", () => {
      for (const rule of [canViewAgent, canViewTranscript, canPersonMessageAgent, canSeeAgentSkills]) {
        expect(rule(OWNER, agent, [])).toBe(true);
      }
    });
  });

  describe("canManageConversationShares", () => {
    it("should allow the owner", () => {
      expect(canManageConversationShares(OWNER, CONVERSATION)).toBe(true);
    });

    it.each([
      ["a recipient of it", RECIPIENT],
      ["a write grantee of the owner's agents", WRITER],
      ["a stranger", STRANGER]
    ])("should refuse %s", (_label, actorOid) => {
      expect(canManageConversationShares(actorOid, CONVERSATION)).toBe(false);
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
      ["a write grantee of the owner's agents", WRITER],
      ["a stranger", STRANGER]
    ])("should refuse %s sharing someone else's conversation", (_label, actorOid) => {
      expect(canShareConversationWith(actorOid, CONVERSATION, STRANGER, true)).toBe(false);
    });
  });

  describe("canForkConversation", () => {
    const FORKER = "oid-forker";
    const FORKS: ConversationShare[] = [
      { conversationId: CONVERSATION.id, recipientOid: FORKER },
      { conversationId: "conv-2", recipientOid: STRANGER }
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
      expect(canForkConversation(STRANGER, CONVERSATION, FORKS)).toBe(false);
    });

    it.each([
      ["a read grantee of the owner's agents", READER],
      ["a write grantee of the owner's agents", WRITER]
    ])("should refuse %s when no fork names them", (_label, viewerOid) => {
      expect(canForkConversation(viewerOid, CONVERSATION, FORKS)).toBe(false);
    });

    it("should refuse the person once offered when the offer has been withdrawn", () => {
      expect(canForkConversation(FORKER, CONVERSATION, [])).toBe(false);
    });

    it("should let the person offered read the share page when their fork row is read beside the shares", () => {
      expect(canViewSharedConversation(FORKER, CONVERSATION, [...SHARES, ...FORKS])).toBe(true);
      expect(conversationAccess(FORKER, CONVERSATION, [...SHARES, ...FORKS])).toBe("reader");
    });

    it("should not let the person offered message the conversation's agent when they hold a fork of it", () => {
      const agent: AgentRef = { id: "conversation-agent", ownerOid: OWNER, ownerOnly: true };
      for (const rule of [canViewAgent, canViewTranscript, canPersonMessageAgent, canSeeAgentSkills]) {
        expect(rule(FORKER, agent, [])).toBe(false);
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

  describe("canSuggestPerson", () => {
    it("should offer anyone else the hub knows", () => {
      expect(canSuggestPerson(OWNER, { oid: STRANGER })).toBe(true);
    });

    it("should not offer the viewer themselves", () => {
      expect(canSuggestPerson(OWNER, { oid: OWNER })).toBe(false);
    });
  });
});

describe("the Atlassian rules", () => {
  // The search and the defaults are both about the owner's own Atlassian account, so a grant over their agents, even
  // a `write` one, must not reach either.
  it.each<[boolean, Role]>([
    [true, "owner"],
    [false, "read grantee"],
    [false, "write grantee"],
    [false, "stranger"]
  ])("should answer %s when the %s searches Atlassian through the owner's assistant", (expected, role) => {
    expect(canLookUpAtlassian(ROLES[role], { ownerOid: OWNER })).toBe(expected);
  });

  it.each<[boolean, Role]>([
    [true, "owner"],
    [false, "write grantee"],
    [false, "stranger"]
  ])("should answer %s when the %s changes the owner's export defaults", (expected, role) => {
    expect(canManageExportDefaults(ROLES[role], OWNER)).toBe(expected);
  });
});
