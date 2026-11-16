import { HttpError } from "../agent-api/http.ts";
import type { MicrosoftRefresh } from "../auth/entra.ts";
import {
  type CredentialVia,
  credentialVersion,
  deleteCredentialIf,
  readCredentialVersion,
  replaceCredentialIf,
  type SecretStore
} from "../credentials/store.ts";
import type { PrismaClient } from "../store/prisma.ts";
import { accessTokenView, type MicrosoftAccessToken, parseSignIn, serialiseSignIn } from "./microsoft.ts";

/**
 * A Graph access token for a person, minted in the hub from their Microsoft 365 connection, for their own pod or for
 * them at their own command line. The refresh token is redeemed here with the hub's client secret and never handed
 * out; what Entra rotates it to is kept in its place.
 *
 * A token is kept in this process until shortly before it expires, against the version of the connection it was
 * minted from, so an agent asking again and again neither rotates the refresh token nor writes to Key Vault each time.
 * A disconnect or a fresh connect moves the version on, so a cached token from before either is never handed out.
 */

/** How long a cached token must still have to run to be handed out, so the agent is not given one about to expire. */
export const MIN_REMAINING_MS = 5 * 60_000;

interface Cached {
  version: number;
  token: MicrosoftAccessToken;
}

/** One cache per process, on `globalThis` because Next builds route handlers as separate module graphs. */
const globalForTokens = globalThis as unknown as { microsoftTokens?: Map<string, Cached>; microsoftMints?: Map<string, Promise<MicrosoftAccessToken>> };
globalForTokens.microsoftTokens ??= new Map();
globalForTokens.microsoftMints ??= new Map();
const cache = globalForTokens.microsoftTokens;
const inFlight = globalForTokens.microsoftMints;

/** Forgets every cached token: for tests, which share the process. */
export function forgetMicrosoftTokens(): void {
  cache.clear();
  inFlight.clear();
}

export interface MintRequest {
  ownerOid: string;
  /** Who asked, recorded on a rotation it writes: `pod` for the owner's virtual agent, `cli` for the person. */
  via: CredentialVia;
  refresh: (refreshToken: string) => Promise<MicrosoftRefresh>;
  now?: () => number;
}

const NOT_CONNECTED = "Microsoft 365 is not connected: connect it in the CFT Workspace's settings, under Connections";

export async function mintMicrosoftToken(prisma: PrismaClient, secrets: SecretStore, request: MintRequest): Promise<MicrosoftAccessToken> {
  const now = request.now ?? Date.now;
  const version = await credentialVersion(prisma, request.ownerOid, "microsoft");
  if (version === undefined) {
    cache.delete(request.ownerOid);
    throw new HttpError(404, NOT_CONNECTED);
  }
  const cached = cache.get(request.ownerOid);
  if (cached !== undefined && cached.version === version.getTime() && Date.parse(cached.token.expires_at) - now() > MIN_REMAINING_MS) {
    return cached.token;
  }
  // One refresh per owner at a time: two that raced would each redeem the same refresh token.
  const running = inFlight.get(request.ownerOid);
  if (running !== undefined) {
    return await running;
  }
  const minting = mint(prisma, secrets, request, now).finally(() => inFlight.delete(request.ownerOid));
  inFlight.set(request.ownerOid, minting);
  return await minting;
}

async function mint(prisma: PrismaClient, secrets: SecretStore, request: MintRequest, now: () => number): Promise<MicrosoftAccessToken> {
  const { ownerOid, via } = request;
  const stored = await readCredentialVersion(prisma, secrets, ownerOid, "microsoft");
  const signIn = stored === undefined ? undefined : parseSignIn(stored.value);
  if (stored === undefined || signIn === undefined) {
    throw new HttpError(404, NOT_CONNECTED);
  }

  const answer = await request.refresh(signIn.refreshToken);
  if (!answer.ok) {
    if (answer.failure === "reconnect") {
      // A refresh token Entra refuses never works again, so it goes, and settings says "Not connected" rather than a
      // connection every agent is refused through. Only that same one: a connection made since is the person's.
      cache.delete(ownerOid);
      await deleteCredentialIf(prisma, secrets, { actorOid: ownerOid, ownerOid, kind: "microsoft" }, stored.updatedAt);
      throw new HttpError(409, "the Microsoft 365 connection has lapsed: connect it again in the CFT Workspace's settings, under Connections");
    }
    console.warn(`a Microsoft Graph token could not be minted: ${answer.error}`);
    throw new HttpError(502, "Microsoft did not answer the token request; try again shortly");
  }

  const scope = answer.scope === "" ? signIn.scope : answer.scope;
  const token = accessTokenView(answer.accessToken, answer.expiresIn, scope, now());
  let version = stored.updatedAt;
  if (answer.refreshToken !== undefined && (answer.refreshToken !== signIn.refreshToken || scope !== signIn.scope)) {
    const written = await replaceCredentialIf(
      prisma,
      secrets,
      { actorOid: ownerOid, ownerOid, kind: "microsoft", value: serialiseSignIn({ ...signIn, refreshToken: answer.refreshToken, scope }), via },
      stored.updatedAt
    );
    if (!written.written && written.reason === "gone") {
      // Disconnected while this refresh was in flight: the disconnect wins, and its token is not handed out.
      cache.delete(ownerOid);
      throw new HttpError(404, NOT_CONNECTED);
    }
    if (!written.written) {
      // Connected again meanwhile: the token is good, but is not cached against a connection that has been replaced.
      return token;
    }
    version = written.updatedAt;
  }
  cache.set(ownerOid, { version: version.getTime(), token });
  return token;
}

/**
 * The hub's Entra settings for a refresh, or 503: a deployment without its client secret (preview mounts only the
 * client id) cannot redeem a refresh token, and must say so rather than call Microsoft with half a client.
 */
export function refreshSettings<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new HttpError(503, `Microsoft 365 tokens are not available on this deployment: ${error instanceof Error ? error.message : String(error)}`);
  }
}
