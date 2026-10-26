/**
 * Who may do what, as pure functions over rows the caller has already loaded.
 *
 * - Topics are open: anyone signed in and any registered agent may read and post.
 * - An agent's details, status and direct-message thread are visible to its owner and to anyone holding a read or
 *   write grant from that owner. So, for now, is its transcript.
 * - A person may message an agent they own or hold a write grant for, and only they see the skills it offers.
 * - An agent may message another agent when its owner owns the target or holds a write grant from the target's
 *   owner.
 * - Only an owner changes their grants, and only to people the hub already knows.
 * - Only a person saves, replaces or deletes their own credentials. No grant extends to them. Of their values, they
 *   may read back their own Amazon Bedrock API key, their CLAUDE.md and their git identity, with their own token;
 *   every other kind is write-only for them. `canOwnerReadCredential` says why those three and nothing else.
 * - A virtual agent is visible to whoever may see its owner's agents, since its sessions are among them. Only that
 *   person manages it and sees its login codes. A virtual agent's launch token acts
 *   as its owner for that virtual agent and the agents its sessions registered, and for nothing else of theirs.
 * - An HMCTS Assistant conversation, and the agent its sessions run as, are its owner's alone: no grant extends to
 *   either, since the conversation is a private chat rather than a session they chose to share. Nor to a file
 *   attached to one of its messages: only the person who uploaded it may add parts to it, discard it or download it
 *   back, and only the session of the conversation it was attached to may fetch its bytes. Nor to the person's saved
 *   Assistant templates, which only they read or change.
 * - A conversation its owner may nonetheless share, read-only, with people they name one at a time. A recipient
 *   reads the thread and the document on the share's own page and can do nothing else: not send, stop an answer,
 *   rename, delete, edit the document, download an attachment, search for the chat, or watch it live. The share does
 *   not reach the conversation's agent, so every rule above still answers `none` for a recipient.
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
  /** An assistant conversation's agent, which no grant extends to. */
  ownerOnly?: boolean;
}

export interface MessageRef {
  kind: "post" | "direct";
  authorOid: string;
  authorAgent: AgentRef | null;
  targetAgent: AgentRef | null;
  /** Who wrote the message this one replies to, if it is a reply. */
  parentAuthorOid: string | null;
}

/** The level a grant gives `viewerOid` over `agent`: none for an owner-only agent, whatever they were granted. */
function grantOver(grants: readonly Grant[], agent: AgentRef, viewerOid: string): GrantLevel | undefined {
  return agent.ownerOnly === true ? undefined : grantLevel(grants, agent.ownerOid, viewerOid);
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
  return viewerOid === agent.ownerOid || grantOver(grants, agent, viewerOid) !== undefined;
}

/**
 * An agent's transcript is visible to whoever may see the agent. Its own rule because a transcript holds far more
 * than the agent's status and thread, so who may read it can narrow without changing who may see the agent.
 */
export function canViewTranscript(viewerOid: string, agent: AgentRef, grants: readonly Grant[]): boolean {
  return canViewAgent(viewerOid, agent, grants);
}

export function canPersonMessageAgent(senderOid: string, target: AgentRef, grants: readonly Grant[]): boolean {
  return senderOid === target.ownerOid || grantOver(grants, target, senderOid) === "write";
}

/**
 * The skills an agent reported are offered to whoever may message it, as the composer's "/" autocomplete. Its own
 * rule because the list says what the agent's session can do on its owner's behalf, which a reader has no use for.
 */
export function canSeeAgentSkills(viewerOid: string, agent: AgentRef, grants: readonly Grant[]): boolean {
  return canPersonMessageAgent(viewerOid, agent, grants);
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
 * Whether a person may read back their own stored credential of `kind`, through `GET /api/agent/credentials/{kind}`
 * or the web UI. An Amazon Bedrock API key, because the workspace's launcher on their laptop fetches it to call
 * Bedrock; and their CLAUDE.md and git identity, because the page that edits them has to show them. Anyone holding
 * that person's agent-hub token can therefore read all three. Every other kind acts as the person in GitHub, Azure,
 * Claude, Jenkins or Atlassian, and stays write-only.
 */
export function canOwnerReadCredential(kind: string): boolean {
  return kind === "bedrock" || kind === "claude_md" || kind === "git_identity";
}

/**
 * Whether a virtual agent's pod may store its owner's credential of `kind`. Not their CLAUDE.md or git identity:
 * every one of the owner's agents follows them, so one agent rewriting either would steer, or commit as someone
 * else for, all the others. Only the owner changes them. Any other kind it may store, and an Atlassian sign-in it
 * has to, again each time `twg` replaces the refresh token in it.
 */
export function canVirtualAgentStoreCredential(kind: string): boolean {
  return kind !== "claude_md" && kind !== "git_identity";
}

/**
 * Whether `actorOid` may read, save, rename or delete `ownerOid`'s saved Assistant templates. Their own alone, and
 * reading is the same decision as writing: a template is a prompt somebody wrote for themselves, so there is nothing
 * about it a reader is entitled to that an editor is not. No grant extends to them, for the same reason none extends
 * to an Assistant conversation — a grant is over sessions a person chose to share, and these are not part of one.
 */
export function canManageTemplate(actorOid: string, ownerOid: string): boolean {
  return actorOid === ownerOid;
}

export type UploadState = "pending" | "stored" | "fetched" | "expired";

/** The columns every upload rule reads. */
export interface UploadRef {
  conversationId: string;
  ownerOid: string;
  /** The message it was attached to, or `null` while the person is still composing. */
  messageId: string | null;
  state: UploadState;
}

/**
 * Whether `viewerOid` may add a part to an upload or discard it. Its own rule rather than `canViewAgent`'s: an upload
 * belongs to the person who started it, and no grant over their agents extends to a file they are part-way through
 * attaching. Once it is attached to a message it is finished with, so there is nothing left to write.
 */
export function canWriteUpload(viewerOid: string, upload: UploadRef): boolean {
  return viewerOid === upload.ownerOid && upload.messageId === null && (upload.state === "pending" || upload.state === "stored");
}

/** Whether an upload may be stamped onto a message of `conversationId`: a finished one of that conversation, once. */
export function canAttachUpload(viewerOid: string, conversationId: string, upload: UploadRef): boolean {
  return viewerOid === upload.ownerOid && upload.conversationId === conversationId && upload.messageId === null && upload.state === "stored";
}

/** `part` reads one part's bytes; `fetched` reports the whole file is on the pod's disk. */
export type AttachmentUse = "part" | "fetched";

/**
 * Whether the session of `conversationId` may do `use` to an attachment. Only an attachment of its own conversation,
 * and only one that reached a message — an upload still being composed is not the pod's business. `part` needs the
 * bytes to still be there; `fetched` also accepts an upload already reported, so a pod that retries after a lost
 * response is answered rather than refused.
 */
export function canSessionUseAttachment(conversationId: string | null, upload: UploadRef, use: AttachmentUse): boolean {
  if (conversationId === null || upload.conversationId !== conversationId || upload.messageId === null) {
    return false;
  }
  return use === "part" ? upload.state === "stored" : upload.state === "stored" || upload.state === "fetched";
}

/**
 * Whether the person may download their file back, and when not, which of the two refusals they get.
 *
 * `not_yours` is the same answer an upload that never existed gets, as every other upload rule gives: an id is not
 * worth confirming. `not_held` is the opposite — it is this person's own file, so they are told plainly that the hub
 * no longer has the bytes, and `src/components/assistant/MessageAttachments.tsx` offers no download when it would
 * come back this way.
 */
export type AttachmentDownload = "ok" | "not_yours" | "not_held";

/**
 * Whether `viewerOid` may download an upload's bytes back. Their own file, in a state whose bytes are complete and
 * still in Postgres, and inside the retention window that `heldUntil` closes.
 *
 * A third rule rather than a third `AttachmentUse`: that one is the conversation's session asking, and it refuses
 * `fetched` because a pod has no business re-reading a file it has already written to its own disk. This is the
 * person asking, and `fetched` is the state nearly every download is served in — the bytes outlive the pod's report
 * now, and only the window takes them.
 *
 * The window decides rather than the state, because the sweep that sets `expired` runs on a timer: a row it has not
 * reached yet is past its window and is refused as though it had.
 */
export function attachmentDownload(viewerOid: string, upload: UploadRef, heldUntil: Date, now: Date): AttachmentDownload {
  if (viewerOid !== upload.ownerOid) {
    return "not_yours";
  }
  // `pending` is here too: its parts are incomplete, so what it would serve is a file with holes in it.
  if ((upload.state !== "stored" && upload.state !== "fetched") || now.getTime() >= heldUntil.getTime()) {
    return "not_held";
  }
  return "ok";
}

/**
 * Whether `viewerOid` may see what a virtual agent's volume holds, and ask for files on it to be deleted. Its owner
 * alone.
 *
 * Its own rule rather than `canViewAgent`'s: a grant is over sessions a person chose to share, and what is on their
 * assistant's disk is neither a session nor something they shared. Reading is the same decision as deleting, because
 * the list is of their own attachments and there is nothing about it a reader is entitled to that a deleter is not —
 * the same reasoning as `canManageTemplate`.
 */
export function canManageUploadsOnDisk(viewerOid: string, ownerOid: string): boolean {
  return viewerOid === ownerOid;
}

/**
 * Whether `viewerOid` may ask for the pod's copy of an upload to be deleted: their own upload, and one that reached a
 * message, since that is the only kind a pod ever fetched.
 *
 * Answers the same `false` for someone else's upload as for one the pod could never have had, so the action that asks
 * it refuses both alike and confirms nothing about an id.
 */
export function canRemoveUploadFromDisk(viewerOid: string, upload: UploadRef): boolean {
  return viewerOid === upload.ownerOid && upload.messageId !== null;
}

/**
 * Whether `viewerOid` may see what an assistant's pod reports about its own memory. Its owner alone.
 *
 * Its own rule rather than `canManageUploadsOnDisk`'s, which is named for the files it decides about: this is read
 * beside a setting that changes the pod's size, and a rule borrowed from another feature is one that moves when that
 * feature's reasoning does. No grant reaches it either way — a grant is over sessions a person chose to share, and
 * how much memory their assistant is using is neither a session nor something they shared.
 */
export function canSeeAssistantMemory(viewerOid: string, ownerOid: string): boolean {
  return viewerOid === ownerOid;
}

export type AgentAccess = "owner" | "write" | "read" | "none";

/** What the viewer may do with an agent, for the UI to decide what to show: the same answers as the checks above. */
export function agentAccess(viewerOid: string, agent: AgentRef, grants: readonly Grant[]): AgentAccess {
  if (viewerOid === agent.ownerOid) {
    return "owner";
  }
  return grantOver(grants, agent, viewerOid) ?? "none";
}

export interface VirtualAgentRef {
  id: string;
  ownerOid: string;
}

/**
 * Whoever may see the agents a virtual agent's sessions register may see the virtual agent itself: its name, its
 * state and its current session. Everything else about it is `canManageVirtualAgent`'s.
 */
export function canViewVirtualAgent(viewerOid: string, virtualAgent: VirtualAgentRef, grants: readonly Grant[]): boolean {
  return canViewAgent(viewerOid, virtualAgent, grants);
}

/**
 * Only its owner starts, stops, renames or deletes a virtual agent, and only they see its device codes or paste a login code
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
 * A conversation as the share rules read it: `ConversationRef`, which is what every rule about a chat takes, and its
 * id as well, because a share is of one conversation rather than of a person's chats.
 */
export interface SharedConversationRef extends ConversationRef {
  id: string;
}

/** One read-only share of one conversation with one named person. The rows are the whole of the access. */
export interface ConversationShare {
  conversationId: string;
  recipientOid: string;
}

export type ConversationAccess = "owner" | "reader" | "none";

/**
 * What the viewer may do with an HMCTS Assistant conversation: own it, read the share of it they were named in, or
 * nothing. The owner-or-grant-holder shape of `canViewVirtualAgent`, with the conversation's own share rows in place
 * of the owner's agent grants, because a share is of one chat rather than of everything its owner has.
 *
 * A link to a shared conversation is a convenience for reaching one of these, never what grants it: someone handed
 * the link who is not named in a row gets `none`, exactly as if the conversation did not exist.
 */
export function conversationAccess(viewerOid: string, conversation: SharedConversationRef, shares: readonly ConversationShare[]): ConversationAccess {
  if (viewerOid === conversation.ownerOid) {
    return "owner";
  }
  return shares.some((share) => share.conversationId === conversation.id && share.recipientOid === viewerOid) ? "reader" : "none";
}

/**
 * Whether `viewerOid` may read a conversation's share page: its owner, or someone they named. What that page shows is
 * narrower than the conversation — the words of the thread and the document, never a file's bytes and never a live
 * update — and `sharedConversation` in `src/assistant/sharing.ts` is what holds it to that.
 *
 * Nothing else widens with it. The conversation's agent stays `ownerOnly`, so `canViewAgent`, `canViewTranscript`,
 * `canPersonMessageAgent` and `canSeeAgentSkills` still answer for a recipient as they do for a stranger, and with
 * them `/api/ui/stream`, every `/api/agent/{agent_id}/…` route and the hub's rosters.
 */
export function canViewSharedConversation(viewerOid: string, conversation: SharedConversationRef, shares: readonly ConversationShare[]): boolean {
  return conversationAccess(viewerOid, conversation, shares) !== "none";
}

/** Only the owner sees who a conversation is shared with, adds someone, or takes them off the list. */
export function canManageConversationShares(actorOid: string, conversation: SharedConversationRef): boolean {
  return actorOid === conversation.ownerOid;
}

/**
 * Whether `actorOid` may share their conversation with `recipientOid`. `recipientKnown` means a `user` row exists, as
 * `canGrant` requires of a grantee: the hub shares with a person it has seen, not with an address.
 */
export function canShareConversationWith(actorOid: string, conversation: SharedConversationRef, recipientOid: string, recipientKnown: boolean): boolean {
  return canManageConversationShares(actorOid, conversation) && recipientKnown && recipientOid !== conversation.ownerOid;
}

/** A name typed into the share dialog has to be this specific before the hub will match anyone against it. */
export const MIN_PEOPLE_QUERY = 2;

/** How many people one lookup answers with. Enough to choose from, and short enough that one ask is not a list. */
export const MAX_PEOPLE_SUGGESTIONS = 8;

export type PeopleLookup = { ok: true; query: string; limit: number } | { ok: false };

/**
 * What `GET /api/ui/people` may answer. The endpoint is an access surface of its own: it says who has used the hub,
 * which is why it answers a search and never a list. A query shorter than `MIN_PEOPLE_QUERY`, once trimmed, is
 * refused rather than answered broadly, and no answer is longer than `MAX_PEOPLE_SUGGESTIONS`.
 *
 * What those two prevent is one request that hands over everyone. What they do not prevent is many: the answer is
 * ordered and never offset, so walking the prefixes and going deeper wherever a full eight come back recovers the
 * list. Nothing in this application is rate limited, so that is true of its other reads as well, and closing it here
 * alone would be a false comfort. Treat the set of people who use the hub as known to anyone signed in.
 *
 * Anyone signed in may ask. The people it matches are colleagues in the same Entra tenant whose names and work
 * addresses that tenant's own directory already gives them; what this adds is only that they have used the hub.
 */
export function peopleLookup(raw: string): PeopleLookup {
  const query = raw.trim();
  return query.length < MIN_PEOPLE_QUERY ? { ok: false } : { ok: true, query, limit: MAX_PEOPLE_SUGGESTIONS };
}

/** Whether a matched person may be offered to `viewerOid` as someone to share with: anyone but themselves. */
export function canSuggestPerson(viewerOid: string, person: { oid: string }): boolean {
  return person.oid !== viewerOid;
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

/** The columns every conversation rule reads. */
export interface ConversationRef {
  ownerOid: string;
}

/**
 * Whether `viewerOid` may see an HMCTS Assistant conversation: its owner, and nobody else. Its own rule rather than
 * `canViewAgent`'s, because this is about the chat rather than about the agent a session of it runs as, and because
 * searching, listing and opening one all have to agree on the same single answer. No grant reaches it: the chat is
 * private, as the note at the top of this file says of its agent.
 */
export function canViewConversation(viewerOid: string, conversation: ConversationRef): boolean {
  return viewerOid === conversation.ownerOid;
}

/**
 * Only its owner stops an answer their conversation is working on. The same single answer as
 * `canViewConversation`'s, and its own rule for the same reason: interrupting a turn is an act on the session rather
 * than a read of the chat, so it is worth saying separately that no grant reaches it — not even a `write` one, which
 * elsewhere lets a grantee message an agent.
 */
export function canStopAssistantAnswer(actorOid: string, conversation: ConversationRef): boolean {
  return actorOid === conversation.ownerOid;
}
