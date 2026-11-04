/**
 * Who may do what, as pure functions over rows the caller has already loaded.
 *
 * - **Everything here is its owner's.** An agent, a virtual agent, a CFT Workspace conversation, a person's
 *   templates and export defaults, a Welsh job and its files, and what an assistant's pod reports are seen and acted
 *   on by the person who owns them and nobody else, and `isOwner` is that one decision. Two rules keep names of
 *   their own because each must be able to narrow without the rest: `canViewTranscript`, for what a session said,
 *   and `canManageVirtualAgent`, for whatever runs as the owner on their own sign-ins. A file attached to a message
 *   is narrower still: the upload rules hold it to its owner and also to its state, its conversation and its
 *   message.
 * - **Reaching somebody else's agent is a tagged post.** `tagRefusal` lets anyone tag anyone's agent, bar a pod
 *   conversation's (the Assistant, a private chat rather than a session on the board) and the tagger itself. It is
 *   the one cross-owner route to a session, and a public one: a post is on a board every signed-in person reads.
 * - **A conversation is read by its owner and by whoever they share it with**, one named person and one chat at a
 *   time. `conversationAccess` is the one rule that reads the share rows and `canForkConversation` the one that reads
 *   fork offers. A share or a fork is never of the agent, so every agent rule answers a recipient as a stranger.
 *
 * A direct message is between one owner's sessions, or is an agent's reply to a person (`canReadMessage`,
 * `replyRoute`). A launch token acts as its owner only for its own virtual agent and the agents its sessions
 * registered. Only its owner saves, replaces or deletes a credential (`isOwner`), and its value is write-only for
 * them except the kinds `canOwnerReadCredential` allows; which kinds a pod may store is
 * `canVirtualAgentStoreCredential`.
 */

export interface AgentRef {
  id: string;
  ownerOid: string;
  /**
   * A pod conversation's agent — the CFT Workspace, which a person chats with privately. Read by `tagRefusal`
   * alone: it is not a session on the board, so no post may tag it. Everything else about an agent is its owner's
   * whatever this says, so no other rule has to ask.
   */
  ownerOnly?: boolean;
}

/** The columns `isPodConversationAgent` reads: an agent row's own, so deciding joins nothing. */
export interface AgentConversationColumns {
  assistantConversationId: string | null;
  virtualAgentId: string | null;
}

/**
 * Whether an agent row is a pod conversation's, which is what `AgentRef`'s `ownerOnly` carries.
 *
 * A pod conversation's agent always has the virtual agent whose pod runs it: `createConversationAgent` selects it
 * from the `virtual_agent` row the conversation names, and a pod's `registerAgent` sets it from its launch token,
 * which is also how a register for a conversation is held to that conversation's own virtual agent. So a conversation
 * agent with no virtual agent is a session on somebody's laptop, and the two come apart without a join.
 */
export function isPodConversationAgent(agent: AgentConversationColumns): boolean {
  return agent.assistantConversationId !== null && agent.virtualAgentId !== null;
}

export interface MessageRef {
  kind: "post" | "direct";
  authorOid: string;
  authorAgent: AgentRef | null;
  targetAgent: AgentRef | null;
  /** Who wrote the message this one replies to, if it is a reply. */
  parentAuthorOid: string | null;
}

/**
 * Whether `oid` owns `owned`: who may see an agent or a virtual agent, message an agent or answer its questions, be
 * offered its skills, open, search, stop or share an Assistant conversation, see what an assistant's pod reports
 * about its memory and its disk, run a Welsh job and read it and its files, read or change a person's templates and
 * export defaults, and save or delete their credentials. One decision, because each of those is something of the
 * owner's that nobody else has standing to reach; the share rows that `conversationAccess` reads are the only
 * widening of any of it. A row rather than a bare oid, so that an agent id passed by mistake does not type-check.
 */
export function isOwner(oid: string, owned: { ownerOid: string }): boolean {
  return oid === owned.ownerOid;
}

/**
 * Who may read what an agent's session said: its owner. Its own rule rather than `isOwner` because a transcript holds
 * far more than the agent's status, so who may read it has to be able to narrow without changing who may see the
 * agent.
 *
 * One rule for both halves of a conversation, because its words are kept in two places. What the session wrote is
 * transcript entries; what the person typed into the composer, and the session's answers to it, are direct messages
 * to the agent (`sendToConversation` sends through `directAsPerson`). A rule applied to only one of the two would
 * narrow the transcript and leave the same conversation readable through the agent's thread, so `canReadMessage`
 * reads this one too, as do the transcript route and the questions beside it.
 *
 * No share or fork row is read here. The one reader of a shared conversation, `sharedConversation` in
 * `src/assistant/sharing.ts`, reads as `conversation.ownerOid` and is where what a recipient may see is cut back to
 * the words of the thread; so a recipient reaches a transcript as the owner or not at all.
 */
export function canViewTranscript(viewerOid: string, agent: AgentRef): boolean {
  return isOwner(viewerOid, agent);
}

/**
 * An agent may send a direct message to another agent of the same owner — one of its own person's sessions talking to
 * another, which is what a direct message now is.
 *
 * Another owner's agent is reached by tagging it in a post instead (`tagRefusal`), so this rule refusing a stranger
 * takes nothing away: it moves the cross-owner route onto the board, where a session's words to somebody else's
 * session are visible to that person rather than arriving in a thread only two agents can see. `replyRoute` holds an
 * answer to the same rule.
 */
export function canAgentMessageAgent(sender: AgentRef, target: AgentRef): boolean {
  return isOwner(sender.ownerOid, target);
}

/**
 * A person may send a direct message to their own agent, unless it is a virtual agent's own session rather than one of
 * its conversations. A pod's owner writes to it through the CFT Workspace, whose every message goes to a
 * conversation's session with the frame that tells it the owner is writing; the client frames anything else a pod
 * session receives as a peer's, so a direct to the pod's own session would reach it disowned.
 */
export function canPersonDirectAgent(senderOid: string, target: AgentRef & { virtualAgentId: string | null; ownerOnly: boolean }): boolean {
  return isOwner(senderOid, target) && (target.virtualAgentId === null || target.ownerOnly);
}

/** Why a post may not tag an agent: `not_taggable` is answered as a missing agent, `itself` as a bad request. */
export type TagRefusal = "not_taggable" | "itself";

/**
 * Whether a post by `authorAgentId` — `null` for a person posting from the web UI — may tag `target`, and if not,
 * which refusal it gets. `undefined` means it may.
 *
 * **Anyone may tag anyone's agent, and that is the rule, not an omission.** This is the one way to reach a session
 * that is not yours, so a check on who the tagger is would leave no way at all. It costs the target's owner nothing
 * they had not already accepted: a board is open to everyone signed in, so anything a post could say about an agent
 * can already be said, and all tagging adds is that the agent is sent a post that was public anyway. It hands over
 * no reading — every rule above still answers for the tagger as it does for a stranger.
 *
 * A pod conversation's agent is not taggable by anyone, its owner included: it is the CFT Workspace, a private
 * chat rather than a session on the board, and it is left out of `GET /api/agent/agents` for the same reason. An
 * agent cannot tag itself, as it cannot reply to its own message in `replyRoute`.
 */
export function tagRefusal(authorAgentId: string | null, target: AgentRef): TagRefusal | undefined {
  if (target.ownerOnly === true) {
    return "not_taggable";
  }
  return target.id === authorAgentId ? "itself" : undefined;
}

/**
 * A post is readable by anyone. A direct message is readable by three people and no others:
 *
 * - whoever sent it, which keeps it readable by its author once the agents on it are gone;
 * - the owner of the thread it sits in — the target agent's, or, for an agent's reply to a person (which has no
 *   target agent), the replying agent's own — by `canViewTranscript`, because a thread is words;
 * - the person an agent replied to, who can read that reply without being able to see the replying agent at all.
 *   Without this a session answering somebody else's post privately would be answering into a thread that person
 *   cannot open.
 */
export function canReadMessage(viewerOid: string, message: MessageRef): boolean {
  if (message.kind === "post" || viewerOid === message.authorOid) {
    return true;
  }
  if (message.targetAgent === null && message.parentAuthorOid === viewerOid) {
    return true;
  }
  const thread = message.targetAgent ?? message.authorAgent;
  return thread !== null && canViewTranscript(viewerOid, thread);
}

export type ReplyRoute = { to: "agent"; target: AgentRef } | { to: "person" } | { to: "nobody"; reason: string; status: 400 | 403 };

/**
 * Where an agent's private reply to a message goes. It is always a direct message to the original author.
 *
 * A direct message is answered only by the agent it was sent to. An answer to a person, whether to their post or to
 * their direct message, goes into this agent's own thread, where that person can read it (`canReadMessage`).
 *
 * An answer to an agent goes to it only when both agents have one owner, because a direct message is between one
 * person's sessions. Another owner's agent is answered on the board instead: a post was written to a board, so an
 * answer belongs on it, where the person whose session is being answered can read it. The refusal says to post on the
 * topic and tag the agent, which reaches it on its stream exactly as a direct message would have.
 */
export function replyRoute(sender: AgentRef, message: MessageRef): ReplyRoute {
  if (message.authorAgent?.id === sender.id) {
    return { to: "nobody", reason: "an agent cannot reply to its own message", status: 400 };
  }
  if (message.kind === "direct" && message.targetAgent?.id !== sender.id) {
    return { to: "nobody", reason: "an agent can only reply to a direct message it received", status: 403 };
  }
  if (message.authorAgent === null) {
    return { to: "person" };
  }
  if (!canAgentMessageAgent(sender, message.authorAgent)) {
    const what = message.kind === "direct" ? "an agent of another owner" : "another owner's post";
    return { to: "nobody", reason: `a private reply to ${what} is not allowed; post on the topic and tag that agent instead`, status: 403 };
  }
  return { to: "agent", target: message.authorAgent };
}

/**
 * Whether a person may read back their own stored credential of `kind`, through `GET /api/agent/credentials/{kind}`
 * or the web UI: the one exception to their credentials being write-only for them. Their CLAUDE.md and their git
 * identity, because the page that edits them has to show them. Anyone holding that person's agent-hub token can
 * therefore read both. No model credential is readable: the gateway route stores none at all, and every other kind
 * acts as the person in GitHub, Azure, Claude, Jenkins or Atlassian, so it stays write-only.
 */
export function canOwnerReadCredential(kind: string): boolean {
  // A Microsoft 365 connection is write-only like every sign-in: the person gets access tokens from it, not the token.
  return kind === "claude_md" || kind === "git_identity";
}

/**
 * Whether a virtual agent's pod may store its owner's credential of `kind`. Not their CLAUDE.md or git identity:
 * every one of the owner's agents follows them, so one agent rewriting either would steer, or commit as someone
 * else for, all the others. Only the owner changes them. Any other kind it may store, and an Atlassian sign-in it
 * has to, again each time `twg` replaces the refresh token in it.
 */
export function canVirtualAgentStoreCredential(kind: string): boolean {
  return kind !== "claude_md" && kind !== "git_identity" && !isHubIssuedCredential(kind);
}

/**
 * Whether a credential of `kind` is one only the hub itself writes, from a sign-in the person makes in the web UI, so
 * that no route takes a pasted or uploaded value of it: their Microsoft 365 connection, whose refresh token comes from
 * the hub's own code exchange (`/auth/microsoft/callback`) and nowhere else. Deleting one is still the person's.
 */
export function isHubIssuedCredential(kind: string): boolean {
  return kind === "microsoft";
}

/**
 * Whether a virtual agent's pod may read its owner's stored credential of `kind` back. Every kind but a Microsoft 365
 * connection: that refresh token, with the client secret it is redeemed with, stays in the hub, and a pod is given
 * only a short-lived Graph access token minted from it (`GET /api/virtual/{id}/microsoft/token`), so a pod that is
 * compromised loses at most an hour's access rather than a token that lasts until the person disconnects.
 */
export function canPodReadCredential(kind: string): boolean {
  return kind !== "microsoft";
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
 * Whether `viewerOid` may add a part to an upload or discard it. Narrower than `isOwner`: an upload
 * belongs to the person who started it rather than to any agent of theirs, so it is not the conversation's session
 * that writes it. Once it is attached to a message it is finished with, so there is nothing left to write.
 */
export function canWriteUpload(viewerOid: string, upload: UploadRef): boolean {
  return isOwner(viewerOid, upload) && upload.messageId === null && (upload.state === "pending" || upload.state === "stored");
}

/** Whether an upload may be stamped onto a message of `conversationId`: a finished one of that conversation, once. */
export function canAttachUpload(viewerOid: string, conversationId: string, upload: UploadRef): boolean {
  return isOwner(viewerOid, upload) && upload.conversationId === conversationId && upload.messageId === null && upload.state === "stored";
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
  if (!isOwner(viewerOid, upload)) {
    return "not_yours";
  }
  // `pending` is here too: its parts are incomplete, so what it would serve is a file with holes in it.
  if ((upload.state !== "stored" && upload.state !== "fetched") || now.getTime() >= heldUntil.getTime()) {
    return "not_held";
  }
  return "ok";
}

/**
 * Whether `viewerOid` may ask for the pod's copy of an upload to be deleted: their own upload, and one that reached a
 * message, since that is the only kind a pod ever fetched.
 *
 * Answers the same `false` for someone else's upload as for one the pod could never have had, so the action that asks
 * it refuses both alike and confirms nothing about an id.
 */
export function canRemoveUploadFromDisk(viewerOid: string, upload: UploadRef): boolean {
  return isOwner(viewerOid, upload) && upload.messageId !== null;
}

/**
 * Whether `actorOid` may make a virtual agent act as its owner: start, stop, rename, resize or delete it, see its
 * device codes or paste a login code back to it, and have its pod search Jira or Confluence. Its owner alone, and its
 * own rule rather than `isOwner` because the reason is narrower than ownership: the agent acts with the owner's
 * GitHub, Azure and Atlassian sign-ins, so a code it shows is a sign-in as them and a search it runs reads Atlassian
 * as them. Whatever ever widens who may see a virtual agent must not widen this.
 */
export function canManageVirtualAgent(actorOid: string, virtualAgent: { ownerOid: string }): boolean {
  return isOwner(actorOid, virtualAgent);
}

/**
 * Only its owner opens a virtual agent's web servers through the viewer, as only they see its ports: a server there
 * runs as the owner, with their GitHub and Azure access, and may serve what it read with them.
 */
export function canOpenVirtualAgentPort(actorOid: string, virtualAgent: { ownerOid: string }): boolean {
  return canManageVirtualAgent(actorOid, virtualAgent);
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
 * credentials through its virtual agent's routes instead, so a launch token cannot read anything here.
 */
export function canUseCredentialRoutes(caller: { virtualAgentId?: string }): boolean {
  return caller.virtualAgentId === undefined;
}

/**
 * A conversation as the share rules read it: its owner, and its id as well, because a share is of one conversation
 * rather than of a person's chats.
 */
export interface SharedConversationRef {
  id: string;
  ownerOid: string;
}

/** One read-only share of one conversation with one named person. The rows are the whole of the access. */
export interface ConversationShare {
  conversationId: string;
  recipientOid: string;
}

export type ConversationAccess = "owner" | "reader" | "none";

/**
 * What the viewer may do with a CFT Workspace conversation: own it, read the share of it they were named in, or
 * nothing.
 *
 * **This is the only way anyone reads anything of somebody else's in this application**, and a share row is the whole
 * of it. It is per conversation by design: a person decides one chat at a time, so they can hand over the one that is
 * about the work and nothing about the rest of their day. Access to a session is not granted at all — reaching
 * somebody else's agent is a tagged post, which is public — so there is no second rule beside this one to keep in
 * step with it, and there should not be.
 *
 * A link to a shared conversation is a convenience for reaching one of these, never what grants it: someone handed
 * the link who is not named in a row gets `none`, exactly as if the conversation did not exist.
 */
export function conversationAccess(viewerOid: string, conversation: SharedConversationRef, shares: readonly ConversationShare[]): ConversationAccess {
  if (isOwner(viewerOid, conversation)) {
    return "owner";
  }
  return shares.some((share) => share.conversationId === conversation.id && share.recipientOid === viewerOid) ? "reader" : "none";
}

/**
 * Whether the viewer may read a conversation's slide deck in the browser — its pictures and its .pptx as well as its
 * outline — given what `conversationAccess` answered for them: its owner, and anyone it is shared with or offered to,
 * since a share carries the conversation's words and a deck is words the conversation made, as its document is.
 *
 * Read-only for all but the owner, and through the browser alone: a deck is written only by the conversation's own
 * session, through `ownedAgentRoute`, so nothing here lets a reader change one.
 *
 * Serving a recipient a picture from this origin is safe where serving them an attachment would not be (see
 * `src/assistant/sharing.ts`): a picture's type is what the hub read from its bytes, and only PNG, JPEG and GIF are
 * stored at all.
 */
export function canReadDeck(access: ConversationAccess): boolean {
  return access === "owner" || access === "reader";
}

/**
 * Whether the viewer may change a conversation's deck from the browser — edit its slides, restore an older version as
 * the next one, or have the conversation's pod build a version's .pptx — given what `conversationAccess` answered for
 * them: its owner alone. A reader may look through every version `canReadDeck` lets them read, and download a .pptx the
 * hub already holds, but an edit or a restore writes to someone else's conversation and a build runs in someone else's
 * pod.
 */
export function canChangeDeck(access: ConversationAccess): boolean {
  return access === "owner";
}

/**
 * Whether `actorOid` may share their conversation with `recipientOid`: only the owner shares, as only they see or
 * change who it is shared with (`isOwner`). `recipientKnown` means a `user` row exists: the hub shares with a
 * person it has seen, not with an address.
 */
export function canShareConversationWith(actorOid: string, conversation: SharedConversationRef, recipientOid: string, recipientKnown: boolean): boolean {
  return isOwner(actorOid, conversation) && recipientKnown && recipientOid !== conversation.ownerOid;
}

/**
 * Whether `viewerOid` may take their own copy of a conversation to continue in their own Assistant: someone the owner
 * named in a fork row of it, and nobody else — not the owner, whose chat it already is, and not a reader of a plain
 * share, who was shown the chat and not offered it. `forks` are the conversation's fork rows, in a share's shape.
 *
 * Taking the copy is the only write a fork allows, and it is to the recipient's own Assistant: nothing here lets
 * anyone but the owner write to the conversation itself, and a fork row reaches none of the agent rules above.
 */
export function canForkConversation(viewerOid: string, conversation: SharedConversationRef, forks: readonly ConversationShare[]): boolean {
  return viewerOid !== conversation.ownerOid && forks.some((fork) => fork.conversationId === conversation.id && fork.recipientOid === viewerOid);
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

/**
 * What `GET /api/ui/agents`, the post composer's tag picker, may answer. It matches every agent rather than the
 * viewer's own, because tagging does (`tagRefusal`), and hands over only an agent's name and whose it is, which every
 * post of that agent's already shows in its byline; no status, heartbeat or repo, which are its owner's alone.
 *
 * It shares `peopleLookup`'s bounds on purpose: a list of agents names the people who own them, so it must be no
 * easier to walk than the people search.
 */
export function agentLookup(raw: string): PeopleLookup {
  return peopleLookup(raw);
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
