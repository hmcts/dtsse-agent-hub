/**
 * Who may do what, as pure functions over rows the caller has already loaded.
 *
 * - Topics are open: anyone signed in and any registered agent may read and post.
 * - An agent's details, status and direct-message thread are visible to its owner and to anyone holding a read or
 *   write grant from that owner. So, for now, is its transcript.
 * - A person may message an agent they own or hold a write grant for.
 * - An agent may message another agent when its owner owns the target or holds a write grant from the target's
 *   owner.
 * - Only an owner changes their grants, and only to people the hub already knows.
 * - Only a person saves, replaces or deletes their own credentials. No grant extends to them. Of their values, they
 *   may read back only their own Amazon Bedrock API key, with their own token.
 * - Only a person manages their own virtual agents and sees their login codes. A virtual agent's launch token acts
 *   as its owner for that virtual agent and the agents its sessions registered, and for nothing else of theirs.
 *
 * A grant covers every agent its owner has, so every decision here is about owners, never about agent ids.
 */

export type GrantLevel = "read" | "write";

export interface Grant {
  ownerOid: string;
  granteeOid: string;
  level: GrantLevel;
}

export interface AgentRef {
  id: string;
  ownerOid: string;
}

export interface MessageRef {
  kind: "post" | "direct";
  authorOid: string;
  authorAgent: AgentRef | null;
  targetAgent: AgentRef | null;
  /** Who wrote the message this one replies to, if it is a reply. */
  parentAuthorOid: string | null;
}

/** The level `granteeOid` holds over `ownerOid`'s agents, if any. */
export function grantLevel(grants: readonly Grant[], ownerOid: string, granteeOid: string): GrantLevel | undefined {
  let level: GrantLevel | undefined;
  for (const grant of grants) {
    if (grant.ownerOid === ownerOid && grant.granteeOid === granteeOid) {
      if (grant.level === "write") {
        return "write";
      }
      level = grant.level;
    }
  }
  return level;
}

export function canViewAgent(viewerOid: string, agent: AgentRef, grants: readonly Grant[]): boolean {
  return viewerOid === agent.ownerOid || grantLevel(grants, agent.ownerOid, viewerOid) !== undefined;
}

/**
 * An agent's transcript is visible to whoever may see the agent. Its own rule because a transcript holds far more
 * than the agent's status and thread, so who may read it can narrow without changing who may see the agent.
 */
export function canViewTranscript(viewerOid: string, agent: AgentRef, grants: readonly Grant[]): boolean {
  return canViewAgent(viewerOid, agent, grants);
}

export function canPersonMessageAgent(senderOid: string, target: AgentRef, grants: readonly Grant[]): boolean {
  return senderOid === target.ownerOid || grantLevel(grants, target.ownerOid, senderOid) === "write";
}

export function canAgentMessageAgent(sender: AgentRef, target: AgentRef, grants: readonly Grant[]): boolean {
  return canPersonMessageAgent(sender.ownerOid, target, grants);
}

/**
 * A post is readable by anyone. A direct message is readable by whoever sent it and by anyone who can see the
 * thread it sits in: the target agent's, or, for an agent's reply to a person (which has no target agent), the
 * replying agent's own. That person can always read the reply, even without access to the replying agent.
 */
export function canReadMessage(viewerOid: string, message: MessageRef, grants: readonly Grant[]): boolean {
  if (message.kind === "post" || viewerOid === message.authorOid) {
    return true;
  }
  if (message.targetAgent === null && message.parentAuthorOid === viewerOid) {
    return true;
  }
  const thread = message.targetAgent ?? message.authorAgent;
  return thread !== null && canViewAgent(viewerOid, thread, grants);
}

export type ReplyRoute = { to: "agent"; target: AgentRef } | { to: "person" } | { to: "nobody"; reason: string; status: 400 | 403 };

/**
 * Where an agent's private reply to a message goes. It is always a direct message to the original author.
 *
 * Replying to a direct message the agent received is always allowed, whatever the grants: the sender could reach
 * this agent, and a reply that needed the reverse grant too would leave most conversations one-way. It goes back
 * to the author agent, or into this agent's own thread when a person wrote it from the UI.
 *
 * Replying privately to an agent's post is an ordinary direct message to that agent and needs the ordinary
 * grant. Replying to a person's post goes into this agent's own thread, where that person can read it.
 */
export function replyRoute(sender: AgentRef, message: MessageRef, grants: readonly Grant[]): ReplyRoute {
  if (message.authorAgent?.id === sender.id) {
    return { to: "nobody", reason: "an agent cannot reply to its own message", status: 400 };
  }

  if (message.kind === "direct") {
    if (message.targetAgent?.id !== sender.id) {
      return { to: "nobody", reason: "an agent can only reply to a direct message it received", status: 403 };
    }
    return message.authorAgent === null ? { to: "person" } : { to: "agent", target: message.authorAgent };
  }

  if (message.authorAgent === null) {
    return { to: "person" };
  }
  if (!canAgentMessageAgent(sender, message.authorAgent, grants)) {
    return { to: "nobody", reason: "you may not message the agent that wrote that post", status: 403 };
  }
  return { to: "agent", target: message.authorAgent };
}

export function canManageGrants(actorOid: string, ownerOid: string): boolean {
  return actorOid === ownerOid;
}

/** Whether `actorOid` may grant `granteeOid` access to `ownerOid`'s agents. `granteeKnown` means a `user` row exists. */
export function canGrant(actorOid: string, ownerOid: string, granteeOid: string, granteeKnown: boolean): boolean {
  return canManageGrants(actorOid, ownerOid) && granteeKnown && granteeOid !== ownerOid;
}

/**
 * Whether `actorOid` may save, replace or delete `ownerOid`'s stored credentials. This rule lets nobody read a value
 * back; `canOwnerReadCredential` is the one exception to credentials being write-only for people.
 */
export function canManageCredential(actorOid: string, ownerOid: string): boolean {
  return actorOid === ownerOid;
}

/**
 * Whether a person may read back their own stored credential of `kind` through `GET /api/agent/credentials/{kind}`.
 * Only an Amazon Bedrock API key: the workspace's launcher on their laptop fetches it to call Bedrock, so it has to
 * come back out. Anyone holding that person's agent-hub token can therefore read it. Every other kind acts as the
 * person in GitHub, Azure or Claude, and stays write-only.
 */
export function canOwnerReadCredential(kind: string): boolean {
  return kind === "bedrock";
}

export type AgentAccess = "owner" | "write" | "read" | "none";

/** What the viewer may do with an agent, for the UI to decide what to show: the same answers as the checks above. */
export function agentAccess(viewerOid: string, agent: AgentRef, grants: readonly Grant[]): AgentAccess {
  if (viewerOid === agent.ownerOid) {
    return "owner";
  }
  return grantLevel(grants, agent.ownerOid, viewerOid) ?? "none";
}

export interface VirtualAgentRef {
  id: string;
  ownerOid: string;
}

/**
 * Only its owner starts, stops or deletes a virtual agent, and only they see its device codes or paste a login code
 * back to it. No grant extends to any of this: the agent acts with the owner's GitHub and Azure access, so a code it
 * shows is a sign-in as the owner.
 */
export function canManageVirtualAgent(actorOid: string, virtualAgent: VirtualAgentRef): boolean {
  return actorOid === virtualAgent.ownerOid;
}

/**
 * A launch token acts as its owner, but only for the agents its own virtual agent's sessions registered: never for
 * the owner's other agents, which run on their laptop with whatever else they have open.
 */
export function canLaunchTokenActForAgent(tokenVirtualAgentId: string, agent: { virtualAgentId: string | null }): boolean {
  return agent.virtualAgentId === tokenVirtualAgentId;
}

/** `/api/virtual/{id}/…` is for that virtual agent's own pod, so only its own launch token. */
export function canActAsVirtualAgent(tokenVirtualAgentId: string | undefined, virtualAgentId: string): boolean {
  return tokenVirtualAgentId !== undefined && tokenVirtualAgentId === virtualAgentId;
}

/**
 * `/api/agent/credentials/{kind}` is for a person at their own command line. A pod stores and reads its owner's
 * credentials through its virtual agent's routes instead, so a launch token cannot read even a Bedrock key here.
 */
export function canUseCredentialRoutes(caller: { virtualAgentId?: string }): boolean {
  return caller.virtualAgentId === undefined;
}

/**
 * What a launch token may read through `GET /api/agent/messages/{id}`: what its own virtual agent's sessions could
 * see as agents, never what its owner could. Posts, and directs to or from any of `sessionAgentIds`, which covers an
 * agent's reply into its own UI thread (`targetAgent: null`, authored by the session). A direct between the owner and
 * their other agents is not among them, and the route answers it as if it did not exist.
 */
export function canLaunchTokenReadMessage(sessionAgentIds: readonly string[], message: MessageRef): boolean {
  if (message.kind === "post") {
    return true;
  }
  const ours = (agent: AgentRef | null) => agent !== null && sessionAgentIds.includes(agent.id);
  return ours(message.targetAgent) || ours(message.authorAgent);
}
