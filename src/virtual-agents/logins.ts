import { canManageVirtualAgent } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import { type CredentialKind, isCredentialKind } from "../credentials/names.ts";
import { deleteCredential, type SecretStore } from "../credentials/store.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { PASTED_CODE_TTL_MS } from "./cleanup.ts";
import { MAX_PASTED_CODE_LENGTH, openPastedCode, sealPastedCode } from "./pasted-code.ts";
import { announce } from "./stop.ts";
import { findVirtualAgent, moveTo, restartVirtualAgent, type VirtualAgentRow } from "./store.ts";

/**
 * The logins a pod relays to its owner: a device code to enter at a URL (GitHub, Azure, Atlassian), or a URL whose
 * page gives the owner a code to paste back (`claude setup-token`). The owner alone sees them; the pod fetches a
 * pasted code once, and the hub forgets it.
 */

export type LoginPrompt = "device_code" | "paste_code";

export type LoginState = "pending" | "completed" | "expired" | "failed";

export interface LoginRequest {
  prompt: LoginPrompt;
  verificationUri: string;
  userCode: string | null;
  expiresInSeconds: number;
}

const NO_PASTED_CODE = { pastedCodeCiphertext: null, pastedCodeIv: null, pastedCodeTag: null, pastedCodeExpiresAt: null } as const;

async function lockLogin(db: Database, virtualAgentId: string, kind: CredentialKind) {
  const [locked] = await db.$queryRaw<{ found: number }[]>`
    SELECT 1 AS found FROM virtual_agent_login WHERE virtual_agent_id = ${virtualAgentId}::uuid AND kind = ${kind}::credential_kind FOR UPDATE
  `;
  if (locked === undefined) {
    return undefined;
  }
  return await db.virtualAgentLogin.findUniqueOrThrow({ where: { virtualAgentId_kind: { virtualAgentId, kind } } });
}

/**
 * The pod's new login, replacing any earlier one of the same kind and any code pasted for it. The agent shows as
 * `awaiting_login` until the pod reports its next step. A relayed Azure sign-in is the one the owner asked for, so
 * the request is spent: the next boot relays another only if they ask again.
 */
export async function startLogin(
  prisma: PrismaClient,
  virtualAgent: VirtualAgentRow,
  kind: CredentialKind,
  login: LoginRequest,
  now: Date = new Date()
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const row = {
      prompt: login.prompt,
      verificationUri: login.verificationUri,
      userCode: login.userCode,
      expiresAt: new Date(now.getTime() + login.expiresInSeconds * 1000),
      state: "pending" as const,
      ...NO_PASTED_CODE,
      updatedAt: now
    };
    await tx.virtualAgentLogin.upsert({
      where: { virtualAgentId_kind: { virtualAgentId: virtualAgent.id, kind } },
      create: { virtualAgentId: virtualAgent.id, kind, ...row },
      update: row
    });
    if (kind === "azure") {
      await tx.virtualAgent.update({ where: { id: virtualAgent.id }, data: { azureSignInRequestedAt: null } });
    }
    await moveTo(tx, virtualAgent, "awaiting_login", null, now);
    await announce(tx, virtualAgent.id, virtualAgent.ownerOid);
  });
}

/**
 * Whether the owner has asked this agent for a sign-in of `kind` that its pod has yet to relay. Only Azure is signed in
 * to on request, because it is optional and nothing should put a code in front of somebody who never asked for one;
 * a pod relays every other sign-in it has no credential for whether or not anybody asked.
 */
export async function signInRequested(db: Database, virtualAgentId: string, kind: CredentialKind): Promise<boolean> {
  if (kind !== "azure") {
    return false;
  }
  const row = await db.virtualAgent.findUnique({ where: { id: virtualAgentId }, select: { azureSignInRequestedAt: true } });
  return row?.azureSignInRequestedAt != null;
}

/**
 * The owner's pasted code for the pod to fetch, sealed for at most `PASTED_CODE_TTL_MS`. Only for a login still
 * pending that asked for a code; anyone but the owner is told there is no such agent.
 */
export async function storePastedCode(
  prisma: PrismaClient,
  actorOid: string,
  virtualAgentId: string,
  kind: CredentialKind,
  rawCode: unknown,
  secret: string,
  now: Date = new Date()
): Promise<void> {
  const code = typeof rawCode === "string" ? rawCode.trim() : "";
  if (code === "") {
    throw new HttpError(400, "paste the code the sign-in page gave you");
  }
  if (code.length > MAX_PASTED_CODE_LENGTH) {
    throw new HttpError(400, `a code is at most ${MAX_PASTED_CODE_LENGTH} characters`);
  }
  await prisma.$transaction(async (tx) => {
    const virtualAgent = await findVirtualAgent(tx, virtualAgentId);
    if (virtualAgent === undefined || !canManageVirtualAgent(actorOid, virtualAgent)) {
      throw new HttpError(404, "no such virtual agent");
    }
    const login = await lockLogin(tx, virtualAgentId, kind);
    if (login === undefined || login.prompt !== "paste_code" || login.state !== "pending" || login.expiresAt.getTime() <= now.getTime()) {
      throw new HttpError(409, "that sign-in is no longer waiting for a code; ask the agent to start it again");
    }
    const sealed = sealPastedCode(secret, virtualAgentId, kind, code);
    await tx.virtualAgentLogin.update({
      where: { virtualAgentId_kind: { virtualAgentId, kind } },
      data: {
        pastedCodeCiphertext: sealed.ciphertext,
        pastedCodeIv: sealed.iv,
        pastedCodeTag: sealed.tag,
        pastedCodeExpiresAt: new Date(now.getTime() + PASTED_CODE_TTL_MS),
        updatedAt: now
      }
    });
    // The owner acting on a sign-in is activity, where the pod's own prompts for it are not; without this the sweep's
    // deadline for an agent waiting on its owner could stop one in the moments between the paste and the pod's fetch.
    await tx.virtualAgent.update({ where: { id: virtualAgentId }, data: { lastActiveAt: now, updatedAt: now } });
    await announce(tx, virtualAgentId, virtualAgent.ownerOid);
  });
}

/**
 * The code the owner pasted, removed as it is read so the pod gets it once; `undefined` when there is none yet or it
 * has expired. A code that no longer opens, because `SESSION_SECRET` changed, is removed too.
 */
export async function takePastedCode(
  prisma: PrismaClient,
  virtualAgent: VirtualAgentRow,
  kind: CredentialKind,
  secret: string,
  now: Date = new Date()
): Promise<string | undefined> {
  return await prisma.$transaction(async (tx) => {
    const login = await lockLogin(tx, virtualAgent.id, kind);
    if (login === undefined || login.pastedCodeCiphertext === null || login.pastedCodeIv === null || login.pastedCodeTag === null) {
      return undefined;
    }
    await tx.virtualAgentLogin.update({
      where: { virtualAgentId_kind: { virtualAgentId: virtualAgent.id, kind } },
      data: { ...NO_PASTED_CODE, updatedAt: now }
    });
    await announce(tx, virtualAgent.id, virtualAgent.ownerOid);
    if (login.pastedCodeExpiresAt === null || login.pastedCodeExpiresAt.getTime() <= now.getTime()) {
      return undefined;
    }
    try {
      return openPastedCode(secret, virtualAgent.id, kind, { ciphertext: login.pastedCodeCiphertext, iv: login.pastedCodeIv, tag: login.pastedCodeTag });
    } catch {
      return undefined;
    }
  });
}

/**
 * Fails the agent, and its Azure sign-in if it has one, because the Azure account it ended up with is not its
 * owner's. Whichever of `complete` and the token cache's save comes first finds it.
 */
export async function failForAzureAccount(prisma: PrismaClient, virtualAgent: VirtualAgentRow, detail: string, now: Date = new Date()): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.virtualAgentLogin.updateMany({
      where: { virtualAgentId: virtualAgent.id, kind: "azure" },
      data: { state: "failed", ...NO_PASTED_CODE, updatedAt: now }
    });
    const current = await findVirtualAgent(tx, virtualAgent.id);
    if (current !== undefined) {
      await moveTo(tx, current, "failed", detail, now);
    }
    await announce(tx, virtualAgent.id, virtualAgent.ownerOid);
  });
}

/**
 * Takes the agent out of `awaiting_login` once no sign-in of any kind is still pending, with `detail` beside the new
 * status. `startLogin` is what put it there, so a login that stops being pending is what takes it back out: left
 * behind, the agent reads as waiting for its owner for ever, and the getting-ready screen asks them to sign in to
 * something no pod is asking about.
 *
 * `running` is the honest answer: only the pod holding the current launch token may report a login over, so a pod
 * reporting one is a pod working again, and its own next report says how far it has got.
 */
async function leaveAwaitingLogin(tx: Database, virtualAgent: VirtualAgentRow, detail: string | null, now: Date): Promise<void> {
  const pending = await tx.virtualAgentLogin.count({ where: { virtualAgentId: virtualAgent.id, state: "pending" } });
  if (pending > 0) {
    return;
  }
  const current = await findVirtualAgent(tx, virtualAgent.id);
  if (current !== undefined && current.status === "awaiting_login") {
    await moveTo(tx, current, "running", detail, now);
  }
}

/**
 * The pod's word that a sign-in it relayed is over and the owner did not finish it: `expired` when the code reached
 * its expiry unused, `failed` for anything else. The counterpart of `completeLogin`, and the only thing that turns a
 * dead code on the owner's screen into something that says so.
 *
 * A sign-in already completed is left alone and answered `204`. Two of a pod's sessions can relay a sign-in of the
 * same kind at once — the CFT Workspace runs one session per conversation and they share one `twg` config — and
 * the loser reporting its own code expired must not un-complete the winner's working sign-in.
 */
export async function failLogin(
  prisma: PrismaClient,
  virtualAgent: VirtualAgentRow,
  kind: CredentialKind,
  outcome: { state: "expired" | "failed"; detail: string | null },
  now: Date = new Date()
): Promise<void> {
  const existing = await prisma.virtualAgentLogin.findUnique({
    where: { virtualAgentId_kind: { virtualAgentId: virtualAgent.id, kind } },
    select: { state: true }
  });
  if (existing === null) {
    throw new HttpError(404, `there is no ${kind} sign-in to report on`);
  }
  if (existing.state === "completed") {
    return;
  }
  await prisma.$transaction(async (tx) => {
    await tx.virtualAgentLogin.update({
      where: { virtualAgentId_kind: { virtualAgentId: virtualAgent.id, kind } },
      data: { state: outcome.state, ...NO_PASTED_CODE, updatedAt: now }
    });
    await leaveAwaitingLogin(tx, virtualAgent, outcome.detail, now);
    await announce(tx, virtualAgent.id, virtualAgent.ownerOid);
  });
}

export interface LoginCompletion {
  accountOid: string | null;
  accountLabel: string | null;
}

/**
 * The pod's word that a login finished. An Azure login must be the owner's own account: anything else is a sign-in
 * as someone else, so the token cache it produced is deleted, the agent is failed and the login with it, and the
 * pod is answered 409. A GitHub, Claude or Atlassian login is simply marked done: an Atlassian account other than the
 * owner's own may be the one they mean their agents to use. Either way the agent leaves `awaiting_login` once no
 * sign-in is still pending.
 */
export async function completeLogin(
  prisma: PrismaClient,
  store: SecretStore | undefined,
  virtualAgent: VirtualAgentRow,
  kind: CredentialKind,
  completion: LoginCompletion,
  now: Date = new Date()
): Promise<void> {
  const existing = await prisma.virtualAgentLogin.findUnique({
    where: { virtualAgentId_kind: { virtualAgentId: virtualAgent.id, kind } },
    select: { state: true }
  });
  if (existing === null) {
    throw new HttpError(404, `there is no ${kind} sign-in to complete`);
  }

  if (kind === "azure" && completion.accountOid !== virtualAgent.ownerOid) {
    if (store !== undefined) {
      await deleteCredential(prisma, store, { actorOid: virtualAgent.ownerOid, ownerOid: virtualAgent.ownerOid, kind: "azure" });
    }
    const detail = "the Azure sign-in was for a different account from the owner's, so its token cache was deleted; sign in as yourself";
    await failForAzureAccount(prisma, virtualAgent, detail, now);
    throw new HttpError(409, detail);
  }

  await prisma.$transaction(async (tx) => {
    await tx.virtualAgentLogin.update({
      where: { virtualAgentId_kind: { virtualAgentId: virtualAgent.id, kind } },
      data: { state: "completed", ...NO_PASTED_CODE, updatedAt: now }
    });
    if (completion.accountLabel !== null) {
      const { count } = await tx.credential.updateMany({ where: { ownerOid: virtualAgent.ownerOid, kind }, data: { accountLabel: completion.accountLabel } });
      if (count > 0) {
        await notify(tx, { type: "credential", owner_oid: virtualAgent.ownerOid, kind });
      }
    }
    await leaveAwaitingLogin(tx, virtualAgent, null, now);
    await announce(tx, virtualAgent.id, virtualAgent.ownerOid);
  });
}

/** The kinds a virtual agent signs in to itself, relaying a device code to its owner, rather than being pasted. */
export const SIGN_IN_KINDS = ["github", "azure", "atlassian"] as const satisfies readonly CredentialKind[];

export type SignInKind = (typeof SIGN_IN_KINDS)[number];

export function isSignInKind(kind: string): kind is SignInKind {
  return (SIGN_IN_KINDS as readonly string[]).includes(kind);
}

/** What the owner is told they are signing in to again. */
export const SIGN_IN_TITLES: Record<SignInKind, string> = { github: "GitHub", azure: "Azure", atlassian: "Atlassian" };

/**
 * The owner's request to sign in to `kind`, again or for the first time: their stored credential is deleted and the
 * virtual agent, if it is running, restarted, so its new pod finds none and relays a fresh sign-in. A stopped one
 * signs in when it next starts. The agent is checked first, so an id that is not the actor's deletes nothing.
 *
 * An Azure sign-in is relayed only on request, so this is also how the owner connects Azure at all: it records the
 * request for `signInRequested`, which the new pod reads, before restarting.
 */
export async function reconnectSignIn(
  prisma: PrismaClient,
  store: SecretStore,
  actorOid: string,
  virtualAgentId: string,
  kind: SignInKind,
  now: Date = new Date()
): Promise<VirtualAgentRow> {
  const virtualAgent = await findVirtualAgent(prisma, virtualAgentId);
  if (virtualAgent === undefined || !canManageVirtualAgent(actorOid, virtualAgent)) {
    throw new HttpError(404, "no such virtual agent");
  }
  if (virtualAgent.desired === "deleted") {
    throw new HttpError(409, "that virtual agent is being deleted");
  }
  await deleteCredential(prisma, store, { actorOid, ownerOid: virtualAgent.ownerOid, kind });
  if (kind === "azure") {
    await prisma.virtualAgent.update({ where: { id: virtualAgentId }, data: { azureSignInRequestedAt: now } });
  }
  return await restartVirtualAgent(prisma, actorOid, virtualAgentId, `restarting to sign in to ${SIGN_IN_TITLES[kind]} again`, now);
}

export interface LoginView {
  kind: CredentialKind;
  prompt: LoginPrompt;
  userCode: string | null;
  verificationUri: string;
  expiresAt: string;
  state: LoginState;
  /**
   * When `state` was last written, which is what orders a sign-in against the credential it is for: a `credential`
   * row carries its own `updatedAt`, and the later of the two is the newer fact about whether the stored value
   * works. Nothing deletes a credential when its sign-in fails, so this is the only thing that tells a working
   * credential from one a pod has just failed to use.
   */
  updatedAt: string;
  /**
   * When a code the owner pasted stops being there for the pod to collect, or `null` when they have pasted none.
   *
   * The deadline rather than a flag, because the two are not the same answer for as long as 50 minutes:
   * `takePastedCode` gives the pod nothing once this has passed but leaves the column set, and a login may run for
   * `MAX_LOGIN_SECONDS` while a pasted code keeps for `PASTED_CODE_TTL_MS`. A flag read off the column would tell
   * the owner their code was on its way for the rest of the hour, with the box to paste another one hidden —
   * `storePastedCode` would still take one.
   */
  codeWaitingUntil: string | null;
}

/** The virtual agent's logins, for its owner's page. Never a pasted code. */
export async function loginViews(db: Database, virtualAgentId: string): Promise<LoginView[]> {
  const rows = await db.virtualAgentLogin.findMany({
    where: { virtualAgentId },
    select: { kind: true, prompt: true, userCode: true, verificationUri: true, expiresAt: true, state: true, updatedAt: true, pastedCodeExpiresAt: true }
  });
  // The column's type still carries `bedrock`, which `20261107090000_bedrock_gone` deletes the rows for without
  // dropping the label, so a row the application has no kind for is left out rather than widening the view.
  return rows
    .filter((row) => isCredentialKind(row.kind))
    .map((row) => ({
      kind: row.kind as CredentialKind,
      prompt: row.prompt,
      userCode: row.userCode,
      verificationUri: row.verificationUri,
      expiresAt: row.expiresAt.toISOString(),
      state: row.state,
      updatedAt: row.updatedAt.toISOString(),
      codeWaitingUntil: row.pastedCodeExpiresAt?.toISOString() ?? null
    }));
}
