import * as client from "openid-client";
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
  const { state, nonce, codeVerifier, returnTo } = payload;
  if (typeof state !== "string" || typeof nonce !== "string" || typeof codeVerifier !== "string") {
    return undefined;
  }
  return { state, nonce, codeVerifier, returnTo: typeof returnTo === "string" ? returnTo : "/" };
}

export function beginSignIn(returnTo: string): SignInState {
  return {
    state: client.randomState(),
    nonce: client.randomNonce(),
    codeVerifier: client.randomPKCECodeVerifier(),
    returnTo
  };
}

export async function authorizationUrl(settings: AuthSettings, signIn: SignInState): Promise<URL> {
  return client.buildAuthorizationUrl(await configuration(settings), {
    redirect_uri: settings.redirectUri,
    // Identity-platform scopes only, so the registration needs no admin consent. `profile` is what puts `oid` in
    // the id token.
    scope: "openid profile email",
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
export const AI_GATEWAY_ROLE = "AIGateway.User";

export function hasAiGatewayRole(roles: unknown): boolean {
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
