import { describe, expect, it } from "vitest";
import {
  type AgentRef,
  agentAccess,
  canActAsVirtualAgent,
  canAgentMessageAgent,
  canGrant,
  canLaunchTokenActForAgent,
  canLaunchTokenReadMessage,
  canManageCredential,
  canManageGrants,
  canManageVirtualAgent,
  canOwnerReadCredential,
  canPersonMessageAgent,
  canReadMessage,
  canSeeAgentSkills,
  canUseCredentialRoutes,
  canViewAgent,
  canViewTranscript,
  type Grant,
  grantLevel,
  type MessageRef,
  replyRoute
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

  it.each(["github", "azure", "claude", "Bedrock", ""])("should keep %j write-only when it is any other kind", (kind) => {
    expect(canOwnerReadCredential(kind)).toBe(false);
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
