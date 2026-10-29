/**
 * Who may do what, as pure functions over rows the caller has already loaded.
 *
 * Three sentences carry the whole model, and most of what follows is one of them applied to a surface.
 *
 * - **An agent is its owner's.** Who may see it, message it, see the skills it offers, read what its session said
 *   and read its thread is the person who owns it, and nobody else. There is no standing access of one person's
 *   agents to another: nothing here takes a grant, because no row grants one.
 * - **Reaching somebody else's agent is a tagged post.** `tagRefusal` decides who may be tagged — anyone, by
 *   anyone, bar the two it names — and the post is pushed to each agent it tags on the stream that agent already
 *   holds. That is the one cross-owner route to a session, and it is deliberately a public one: a post is on a board
 *   every signed-in person reads, so reaching an agent costs the sender the same openness it costs its owner.
 * - **A conversation is read by its owner and by whoever they share it with.** The share rows are the whole of that
 *   access, one conversation at a time, and `conversationAccess` is the one rule that reads them.
 *
 * The rest:
 *
 * - Topics are open: anyone signed in and any registered agent may read and post.
 * - A direct message is between an owner's own sessions, or it is a reply: it is readable by whoever wrote it, by the
 *   owner of the thread it sits in, and by the person an agent replied to. `canReadMessage` is where those three are
 *   said. An agent may always answer a direct it received, whatever the owner — `replyRoute` explains why.
 * - Only a person saves, replaces or deletes their own credentials. Of their values, they may read back their
 *   CLAUDE.md and their git identity, with their own token; every other kind is write-only for them.
 *   `canOwnerReadCredential` says why those two and nothing else.
 * - A virtual agent is visible to whoever may see its owner's agents, since its sessions are among them, which makes
 *   it its owner's too. Only that person manages it and sees its login codes. A virtual agent's launch token acts as
 *   its owner for that virtual agent and the agents its sessions registered, and for nothing else of theirs.
 * - An HMCTS Assistant conversation, and the agent the sessions on its pod run as, are its owner's: the conversation
 *   is a private chat rather than a session on the board, which is also why `tagRefusal` will not let a post tag one.
 *   A conversation of a session on the person's own laptop has no pod, and its agent is an ordinary session that can
 *   be seen on the board and tagged like any other; what stays private either way are the words. A file attached to
 *   one of a conversation's messages is narrower still: only the person who uploaded it may add parts to it, discard
 *   it or download it back, and only the session of the conversation it was attached to may fetch its bytes. So are
 *   the person's saved Assistant templates, which only they read or change.
 * - A conversation its owner may share, read-only, with people they name one at a time. A recipient reads the thread
 *   and the document on the share's own page and can do nothing else: not send, stop an answer, rename, delete, edit
 *   the document, download an attachment, search for the chat, or watch it live. The share is of the conversation and
 *   never of its agent, so every agent rule above still answers for a recipient exactly as it does for a stranger.
 * - The owner may also offer a conversation, one named person at a time, to be forked: the recipient reads it as a
 *   share's recipient does, and may take their own copy into their own Assistant. The copy is theirs; the original
 *   is still the owner's, and nothing about a fork lets its recipient write to it.
 *
 * Every decision about an agent here is about owners rather than agent ids, bar the three that cannot be: the two
 * that have to recognise the agent acting (`tagRefusal`, `replyRoute`) and the one that answers as a launch token's
 * own sessions rather than as their owner (`canLaunchTokenReadMessage`).
 */

export interface AgentRef {
  id: string;
  ownerOid: string;
  /**
   * A pod conversation's agent — the HMCTS Assistant, which a person chats with privately. Read by `tagRefusal`
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

export function canViewAgent(viewerOid: string, agent: AgentRef): boolean {
  return viewerOid === agent.ownerOid;
}

/**
 * An agent's transcript is its owner's. Its own rule rather than `canViewAgent`'s because a transcript holds far more
 * than the agent's status and thread, so who may read it has to be able to narrow without changing who may see the
 * agent — and because what it decides about is words, which is a different thing to argue about from a session.
 *
 * No share or fork row is read here. The one reader of a shared conversation, `sharedConversation` in
 * `src/assistant/sharing.ts`, reads as `conversation.ownerOid` and is where what a recipient may see is cut back to
 * the words of the thread; so a recipient reaches a transcript as the owner or not at all.
 */
export function canViewTranscript(viewerOid: string, agent: AgentRef): boolean {
  return canReadSessionWords(viewerOid, agent);
}

/**
 * Who may read what an agent's session said: its owner.
 *
 * One rule for both halves of a conversation, because its words are kept in two places. What the session wrote is
 * transcript entries; what the person typed into the composer, and the session's answers to it, are direct messages
 * to the agent (`sendToConversation` sends through `directAsPerson`). A rule applied to only one of the two would
 * narrow the transcript and leave the same conversation readable through the agent's thread, which is a privacy
 * claim the code would not keep. `canReadMessage` reads this one for that reason, and so do the transcript route
 * and the questions beside it.
 */
function canReadSessionWords(viewerOid: string, agent: AgentRef): boolean {
  return viewerOid === agent.ownerOid;
}

export function canPersonMessageAgent(senderOid: string, target: AgentRef): boolean {
  return senderOid === target.ownerOid;
}

/**
 * The skills an agent reported are offered to whoever may message it, as the composer's "/" autocomplete. Its own
 * rule because the list says what the agent's session can do on its owner's behalf, which a reader has no use for.
 */
export function canSeeAgentSkills(viewerOid: string, agent: AgentRef): boolean {
  return canPersonMessageAgent(viewerOid, agent);
}

/**
 * An agent may send a direct message to another agent of the same owner — one of its own person's sessions talking to
 * another, which is what a direct message now is.
 *
 * Another owner's agent is reached by tagging it in a post instead (`tagRefusal`), so this rule refusing a stranger
 * takes nothing away: it moves the cross-owner route onto the board, where a session's words to somebody else's
 * session are visible to that person rather than arriving in a thread only two agents can see. The one exception is
 * an answer, which is `replyRoute`'s.
 */
export function canAgentMessageAgent(sender: AgentRef, target: AgentRef): boolean {
  return canPersonMessageAgent(sender.ownerOid, target);
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
 * A pod conversation's agent is not taggable by anyone, its owner included: it is the HMCTS Assistant, a private
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
 * - whoever sent it, which is the check that lets an agent's owner read what it said to a stranger's session;
 * - the owner of the thread it sits in — the target agent's, or, for an agent's reply to a person (which has no
 *   target agent), the replying agent's own — by `canReadSessionWords`, because a thread is words;
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
  return thread !== null && canReadSessionWords(viewerOid, thread);
}

export type ReplyRoute = { to: "agent"; target: AgentRef } | { to: "person" } | { to: "nobody"; reason: string; status: 400 | 403 };

/**
 * Where an agent's private reply to a message goes. It is always a direct message to the original author.
 *
 * **Replying to a direct message the agent received is always allowed, whatever the owner**, and it is the one place
 * a direct crosses between two people's agents. The sender reached this agent, so an answer is what they asked for;
 * refusing it because this agent could not have opened the conversation would leave every cross-owner exchange
 * one-way, with the opener able to speak and the answerer able only to post. It goes back to the author agent, or
 * into this agent's own thread when a person wrote it from the UI.
 *
 * Replying privately to another owner's **post** is refused, and that is the change rather than an oversight: a post
 * was written to a board, so an answer belongs on it, where the person whose session is being answered can read it.
 * The refusal says to post on the topic and tag the agent instead, which reaches it on its stream exactly as a direct
 * message would have. A post of this owner's own is still answerable privately, since both sessions are theirs.
 * Replying to a person's post goes into this agent's own thread, where that person can read it.
 */
export function replyRoute(sender: AgentRef, message: MessageRef): ReplyRoute {
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
  if (!canAgentMessageAgent(sender, message.authorAgent)) {
    return {
      to: "nobody",
      reason: "a private reply to another owner's post is not allowed; post on the topic and tag that agent instead",
      status: 403
    };
  }
  return { to: "agent", target: message.authorAgent };
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
 * or the web UI. Their CLAUDE.md and their git identity, because the page that edits them has to show them. Anyone
 * holding that person's agent-hub token can therefore read both. No model credential is readable: the gateway route
 * stores none at all, and every other kind acts as the person in GitHub, Azure, Claude, Jenkins or Atlassian, so it
 * stays write-only.
 */
export function canOwnerReadCredential(kind: string): boolean {
  return kind === "claude_md" || kind === "git_identity";
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
 * about it a reader is entitled to that an editor is not. Its own rule rather than an agent's, because a template is
 * not part of any session: nothing a person does with their agents, or anyone else's, should ever reach one.
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
 * belongs to the person who started it rather than to any agent of theirs, so it is not the conversation's session
 * that writes it. Once it is attached to a message it is finished with, so there is nothing left to write.
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
 * Its own rule rather than `canViewAgent`'s: what is on an assistant's disk is not a session, so it is not something
 * an agent rule should ever be able to answer for. Reading is the same decision as deleting, because the list is of
 * their own attachments and there is nothing about it a reader is entitled to that a deleter is not — the same
 * reasoning as `canManageTemplate`.
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
 * feature's reasoning does. How much memory someone's assistant is using is not a session either way, so no agent
 * rule should be able to answer for it.
 */
export function canSeeAssistantMemory(viewerOid: string, ownerOid: string): boolean {
  return viewerOid === ownerOid;
}

export interface VirtualAgentRef {
  id: string;
  ownerOid: string;
}

/**
 * Whoever may see the agents a virtual agent's sessions register may see the virtual agent itself: its name, its
 * state and its current session, which makes it its owner's. Everything else about it is `canManageVirtualAgent`'s,
 * whose reasoning is its own and does not follow this one.
 */
export function canViewVirtualAgent(viewerOid: string, virtualAgent: VirtualAgentRef): boolean {
  return canViewAgent(viewerOid, virtualAgent);
}

/**
 * Only its owner starts, stops, renames or deletes a virtual agent, and only they see its device codes or paste a
 * login code back to it. Narrower than `canViewVirtualAgent` on purpose, and the reason is worth keeping in sight:
 * the agent acts with the owner's GitHub and Azure access, so a code it shows is a sign-in as the owner.
 */
export function canManageVirtualAgent(actorOid: string, virtualAgent: VirtualAgentRef): boolean {
  return actorOid === virtualAgent.ownerOid;
}

/**
 * Only its owner opens a virtual agent's web servers through the viewer, as only they see its ports. No grant
 * extends to it: a server there runs as the owner, with their GitHub and Azure access, and may serve what it read
 * with them.
 */
export function canOpenVirtualAgentPort(actorOid: string, virtualAgent: VirtualAgentRef): boolean {
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
 * Nothing else widens with it, because a share is of the conversation and the agent rules are about the agent: a
 * recipient is not its owner, so `canViewAgent`, `canPersonMessageAgent`, `canSeeAgentSkills` and `canViewTranscript`
 * answer for them exactly as they do for a stranger, and with them `/api/ui/stream`, every `/api/agent/{agent_id}/…`
 * route and the hub's rosters.
 */
export function canViewSharedConversation(viewerOid: string, conversation: SharedConversationRef, shares: readonly ConversationShare[]): boolean {
  return conversationAccess(viewerOid, conversation, shares) !== "none";
}

/** Only the owner sees who a conversation is shared with, adds someone, or takes them off the list. */
export function canManageConversationShares(actorOid: string, conversation: SharedConversationRef): boolean {
  return actorOid === conversation.ownerOid;
}

/**
 * Whether `actorOid` may share their conversation with `recipientOid`. `recipientKnown` means a `user` row exists:
 * the hub shares with a person it has seen, not with an address.
 */
export function canShareConversationWith(actorOid: string, conversation: SharedConversationRef, recipientOid: string, recipientKnown: boolean): boolean {
  return canManageConversationShares(actorOid, conversation) && recipientKnown && recipientOid !== conversation.ownerOid;
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
 * What `GET /api/ui/agents` may answer: the agents the post composer offers to tag, by the same search-not-a-list
 * shape as `peopleLookup`, and sharing its two bounds because the reasoning is the same one.
 *
 * It matches every agent rather than the viewer's own, because tagging does (`tagRefusal`): a picker holding only
 * their own sessions would leave out every agent a tag exists to reach. What it hands over — an agent's name and
 * whose it is — is what every post of that agent's already shows in its byline to anyone signed in. It answers no
 * status, heartbeat or repo: those are the agent's page, which is its owner's alone.
 */
export function agentLookup(raw: string): PeopleLookup {
  return peopleLookup(raw);
}

/**
 * Whether a matched agent may be offered to tag: anything the post would not then be refused for. The composer
 * posts as the person signed in, never as one of their agents, so there is no self-tag for it to leave out.
 */
export function canSuggestAgent(agent: AgentRef): boolean {
  return tagRefusal(null, agent) === undefined;
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
 * searching, listing and opening one all have to agree on the same single answer. A share of the conversation is the
 * one thing that widens it, and `conversationAccess` rather than this is where that is read.
 */
export function canViewConversation(viewerOid: string, conversation: ConversationRef): boolean {
  return viewerOid === conversation.ownerOid;
}

/**
 * Only its owner stops an answer their conversation is working on. The same single answer as
 * `canViewConversation`'s, and its own rule for the same reason: interrupting a turn is an act on the session rather
 * than a read of the chat, so it is worth saying separately that a share of the chat does not carry it.
 */
export function canStopAssistantAnswer(actorOid: string, conversation: ConversationRef): boolean {
  return actorOid === conversation.ownerOid;
}

/**
 * Whether `viewerOid` may search Jira or Confluence through a virtual agent: its owner, and nobody else. The search
 * runs with the owner's own Atlassian sign-in, so anyone else asking would be reading Atlassian as them; and the
 * answer goes back only to whoever asked.
 */
export function canLookUpAtlassian(viewerOid: string, virtualAgent: { ownerOid: string }): boolean {
  return viewerOid === virtualAgent.ownerOid;
}

/**
 * Only its owner reads or changes where their documents go by default. Nothing about it is a secret, but it is theirs
 * alone, as their templates are.
 */
export function canManageExportDefaults(actorOid: string, ownerOid: string): boolean {
  return actorOid === ownerOid;
}
