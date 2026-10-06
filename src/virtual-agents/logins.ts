import { canManageVirtualAgent } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import type { CredentialKind } from "../credentials/names.ts";
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
 * `awaiting_login` until the pod reports its next step.
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
    await moveTo(tx, virtualAgent, "awaiting_login", null, now);
    await announce(tx, virtualAgent.id, virtualAgent.ownerOid);
  });
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

export interface LoginCompletion {
  accountOid: string | null;
  accountLabel: string | null;
}

/**
 * The pod's word that a login finished. An Azure login must be the owner's own account: anything else is a sign-in
 * as someone else, so the token cache it produced is deleted, the agent is failed and the login with it, and the
 * pod is answered 409. A GitHub, Claude or Atlassian login is simply marked done: an Atlassian account other than the
 * owner's own may be the one they mean their agents to use.
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
 * The owner's request to sign in to `kind` again: their stored credential is deleted and the virtual agent, if it is
 * running, restarted, so its new pod finds none and relays a fresh sign-in. A stopped one signs in when it next
 * starts. The agent is checked first, so an id that is not the actor's deletes nothing.
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
  return await restartVirtualAgent(prisma, actorOid, virtualAgentId, `restarting to sign in to ${SIGN_IN_TITLES[kind]} again`, now);
}

export interface LoginView {
  kind: CredentialKind;
  prompt: LoginPrompt;
  userCode: string | null;
  verificationUri: string;
  expiresAt: string;
  state: LoginState;
  /** A code the owner pasted is waiting for the pod to fetch it. */
  codeWaiting: boolean;
}

/** The virtual agent's logins, for its owner's page. Never a pasted code. */
export async function loginViews(db: Database, virtualAgentId: string): Promise<LoginView[]> {
  const rows = await db.virtualAgentLogin.findMany({
    where: { virtualAgentId },
    select: { kind: true, prompt: true, userCode: true, verificationUri: true, expiresAt: true, state: true, pastedCodeExpiresAt: true }
  });
  return rows.map((row) => ({
    kind: row.kind,
    prompt: row.prompt,
    userCode: row.userCode,
    verificationUri: row.verificationUri,
    expiresAt: row.expiresAt.toISOString(),
    state: row.state,
    codeWaiting: row.pastedCodeExpiresAt !== null
  }));
}
