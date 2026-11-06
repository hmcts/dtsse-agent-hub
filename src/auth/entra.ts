import * as client from "openid-client";
import { CONNECT_SCOPE, GRAPH_SCOPE, type MicrosoftSignIn, type RefreshFailure, refreshFailure } from "../microsoft/microsoft.ts";
import { SIGN_IN_MAX_AGE } from "./cookies.ts";
import { open, seal } from "./sealed.ts";
import type { Session } from "./session.ts";
import { type AuthSettings, issuerUrl } from "./settings.ts";

/** The Entra half of the web sign-in: discovery, the authorization URL and the code exchange. */

/** What the sign-in has to remember between the redirect out and the callback back. */
export interface SignInState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  /**
   * What the sign-in is for: a person signing in, or one already signed in connecting Microsoft 365. Both come back to
   * the one redirect URI the registration holds, so the callback reads this to know which it is completing.
   */
  purpose?: "microsoft";
}

/** Memoised per process: one tenant and one client per process. */
let discovered: Promise<client.Configuration> | undefined;

export function forgetDiscovery(): void {
  discovered = undefined;
}

/** Cached on success only, so one transient failure after a deploy does not poison every later sign-in. */
export function configuration(settings: AuthSettings): Promise<client.Configuration> {
  discovered ??= client.discovery(issuerUrl(settings.tenantId), settings.clientId, settings.clientSecret).catch((error: unknown) => {
    discovered = undefined;
    throw error;
  });
  return discovered;
}

export async function sealSignIn(signIn: SignInState, secret: string): Promise<string> {
  return await seal({ ...signIn }, secret, SIGN_IN_MAX_AGE);
}

/** The sign-in a callback's cookie describes, or `undefined`; a callback without one must not be completed. */
export async function readSignIn(cookie: string | undefined, secret: string): Promise<SignInState | undefined> {
  const payload = await open(cookie, secret);
  if (payload === undefined) {
    return undefined;
  }
  const { state, nonce, codeVerifier, returnTo, purpose } = payload;
  if (typeof state !== "string" || typeof nonce !== "string" || typeof codeVerifier !== "string") {
    return undefined;
  }
  return { state, nonce, codeVerifier, returnTo: typeof returnTo === "string" ? returnTo : "/", ...(purpose === "microsoft" ? { purpose } : {}) };
}

export function beginSignIn(returnTo: string, purpose?: "microsoft"): SignInState {
  return {
    state: client.randomState(),
    nonce: client.randomNonce(),
    codeVerifier: client.randomPKCECodeVerifier(),
    returnTo,
    ...(purpose === undefined ? {} : { purpose })
  };
}

export async function authorizationUrl(settings: AuthSettings, signIn: SignInState): Promise<URL> {
  return client.buildAuthorizationUrl(await configuration(settings), {
    redirect_uri: settings.redirectUri,
    // Identity-platform scopes only for a sign-in, so signing in to the hub never asks for more than who someone is.
    // `profile` is what puts `oid` in the id token. Connecting Microsoft 365 asks for Graph as well, and only then.
    scope: signIn.purpose === "microsoft" ? CONNECT_SCOPE : "openid profile email",
    // A connect always shows a Microsoft screen, so it is never completed silently by an existing Entra session. It is
    // `select_account` and not `consent`: the Graph permissions are admin-consented, and `prompt=consent` asks the
    // person to consent again themselves, which Entra refuses ("Need admin approval") for anyone who is not an admin.
    ...(signIn.purpose === "microsoft" ? { prompt: "select_account" } : {}),
    state: signIn.state,
    nonce: signIn.nonce,
    code_challenge: await client.calculatePKCECodeChallenge(signIn.codeVerifier),
    code_challenge_method: "S256"
  });
}

export class SignInFailed extends Error {}

/** The session a completed callback establishes, keyed by the id token's `oid` and `tid`. */
export async function completeSignIn(settings: AuthSettings, currentUrl: URL, signIn: SignInState): Promise<Session> {
  let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
  try {
    tokens = await client.authorizationCodeGrant(await configuration(settings), currentUrl, {
      expectedState: signIn.state,
      expectedNonce: signIn.nonce,
      pkceCodeVerifier: signIn.codeVerifier
    });
  } catch (error) {
    throw new SignInFailed(error instanceof Error ? error.message : String(error));
  }

  const claims = tokens.claims();
  const oid = claims?.oid;
  const tid = claims?.tid;
  if (typeof oid !== "string" || oid === "" || typeof tid !== "string" || tid === "") {
    throw new SignInFailed("Entra returned no oid and tid in the id token, so there is no identity to hold a session for");
  }
  if (tid !== settings.tenantId) {
    throw new SignInFailed(`the id token was issued for tenant ${tid}, not ${settings.tenantId}`);
  }

  const email = typeof claims?.email === "string" ? claims.email : typeof claims?.preferred_username === "string" ? claims.preferred_username : undefined;
  return {
    oid,
    tid,
    name: typeof claims?.name === "string" ? claims.name : (email ?? oid),
    ...(email === undefined ? {} : { email }),
    aiGateway: hasAiGatewayRole(claims?.roles)
  };
}

/**
 * The app role whose holders' virtual agents use Amazon Bedrock rather than their own Claude licence. It is
 * assigned to an Entra group and arrives in the id token's `roles` claim, which is absent for anyone holding no role.
 */
const AI_GATEWAY_ROLE = "AIGateway.User";

function hasAiGatewayRole(roles: unknown): boolean {
  return Array.isArray(roles) && roles.includes(AI_GATEWAY_ROLE);
}

/**
 * Where to send a person who has signed out, so Entra forgets them too. No `post_logout_redirect_uri`: Entra only
 * honours one registered on the application, and the registration holds the callback alone.
 */
export async function signOutUrl(settings: AuthSettings): Promise<URL | undefined> {
  const endpoint = (await configuration(settings)).serverMetadata().end_session_endpoint;
  return endpoint === undefined ? undefined : new URL(endpoint);
}

/**
 * The Microsoft 365 connection a completed connect callback establishes for the person signed in. Refused unless the
 * id token is that same person in this tenant, so nobody connects somebody else's mailbox to their agents by signing
 * in as them in the Microsoft prompt, and unless Entra sent a refresh token, which the connection is.
 */
export async function completeMicrosoftConnect(
  settings: AuthSettings,
  currentUrl: URL,
  signIn: SignInState,
  session: { oid: string; tid: string }
): Promise<MicrosoftSignIn> {
  let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
  try {
    tokens = await client.authorizationCodeGrant(await configuration(settings), currentUrl, {
      expectedState: signIn.state,
      expectedNonce: signIn.nonce,
      pkceCodeVerifier: signIn.codeVerifier
    });
  } catch (error) {
    throw new SignInFailed(error instanceof Error ? error.message : String(error));
  }
  const claims = tokens.claims();
  if (claims?.oid !== session.oid || claims?.tid !== session.tid) {
    throw new SignInFailed("the Microsoft account signed in to is not the one signed in to the hub");
  }
  if (typeof tokens.refresh_token !== "string" || tokens.refresh_token === "") {
    throw new SignInFailed("Entra returned no refresh token, so there is no connection to keep");
  }
  const account = [claims.preferred_username, claims.upn, claims.email].find((value): value is string => typeof value === "string" && value !== "");
  return { refreshToken: tokens.refresh_token, account: account ?? null, scope: typeof tokens.scope === "string" ? tokens.scope : "" };
}

/** A refresh Entra answered with a token, the refresh token it rotated to, or why it did not. */
export type MicrosoftRefresh =
  | { ok: true; accessToken: string; expiresIn: number | undefined; scope: string; refreshToken: string | undefined }
  | { ok: false; failure: RefreshFailure; error: string };

/**
 * A Graph access token for a connection, redeemed with the hub's own client secret, which is why this happens here and
 * not in a pod. Entra usually rotates the refresh token as it answers; the caller keeps the new one.
 */
export async function refreshMicrosoftToken(settings: AuthSettings, refreshToken: string): Promise<MicrosoftRefresh> {
  try {
    const tokens = await client.refreshTokenGrant(await configuration(settings), refreshToken, { scope: GRAPH_SCOPE });
    return {
      ok: true,
      accessToken: tokens.access_token,
      expiresIn: tokens.expiresIn(),
      scope: typeof tokens.scope === "string" ? tokens.scope : "",
      refreshToken: typeof tokens.refresh_token === "string" && tokens.refresh_token !== "" ? tokens.refresh_token : undefined
    };
  } catch (error) {
    const code = error instanceof client.ResponseBodyError ? error.error : undefined;
    return { ok: false, failure: refreshFailure(code), error: error instanceof Error ? error.message : String(error) };
  }
}
