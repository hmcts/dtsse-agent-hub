/**
 * A person's Microsoft 365 connection: what the hub asks Entra for when they press Connect, what it keeps of the
 * answer, and what it hands an agent. Pure, so the shape and its checks are tested apart from Entra.
 *
 * Opt-in only. Nothing in the hub asks Microsoft Graph for anything on a person's behalf unless they have connected,
 * which is the one place a `microsoft` credential is written (`/auth/callback`, for a sign-in begun at
 * `/auth/microsoft/connect`). Disconnecting deletes it.
 */

/**
 * The delegated Microsoft Graph permissions the connection asks for: the ones `dtsse-agent-hub` is registered and
 * admin-consented for in `hmcts/central-app-registration`. Delegated, so each acts as the signed-in person and reaches
 * only what they can already reach. Files.ReadWrite is the only one that writes, and only to their own OneDrive.
 */
export const GRAPH_PERMISSIONS = [
  "Mail.Read",
  "Calendars.Read",
  "Files.ReadWrite",
  "Files.Read.All",
  "Sites.Read.All",
  "Chat.Read",
  "ChannelMessage.Read.All",
  "OnlineMeetings.Read",
  "OnlineMeetingTranscript.Read.All"
] as const;

const GRAPH = "https://graph.microsoft.com/";

/** What a refresh asks for: every Graph permission, and `offline_access` so the answer carries a new refresh token. */
export const GRAPH_SCOPE = [...GRAPH_PERMISSIONS.map((permission) => `${GRAPH}${permission}`), "offline_access"].join(" ");

/**
 * What the connect sign-in asks for: the identity scopes as well, so its id token says whose account it is and the
 * callback can refuse one that is not the signed-in person's.
 */
export const CONNECT_SCOPE = `openid profile email ${GRAPH_SCOPE}`;

/** What the hub keeps of a connection, as JSON in the `microsoft` credential. The refresh token never leaves the hub. */
export interface MicrosoftSignIn {
  refreshToken: string;
  /** The Entra account it is for, as `upn`/`preferred_username` gives it: the label settings shows. */
  account: string | null;
  /** The scopes Entra granted, space-separated, which can be fewer than were asked for. */
  scope: string;
}

/** A Key Vault secret value is at most 25 KB; an Entra refresh token is around 2 KB. */
const MAX_SIGN_IN_LENGTH = 16_000;

export function serialiseSignIn(signIn: MicrosoftSignIn): string {
  return JSON.stringify({ refresh_token: signIn.refreshToken, account: signIn.account, scope: signIn.scope });
}

/** The connection a stored value holds, or `undefined` for one that is not a connection the hub wrote. */
export function parseSignIn(value: string): MicrosoftSignIn | undefined {
  if (value.length > MAX_SIGN_IN_LENGTH) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const { refresh_token, account, scope } = parsed as Record<string, unknown>;
  if (typeof refresh_token !== "string" || refresh_token.trim() === "" || typeof scope !== "string") {
    return undefined;
  }
  return { refreshToken: refresh_token, account: typeof account === "string" && account !== "" ? account : null, scope };
}

/** The Graph permissions in a granted scope string, short names only, in `GRAPH_PERMISSIONS`' order. */
export function grantedPermissions(scope: string): string[] {
  const granted = new Set(
    scope
      .split(/\s+/)
      .filter((part) => part !== "")
      .map((part) => (part.toLowerCase().startsWith(GRAPH) ? part.slice(GRAPH.length) : part).toLowerCase())
  );
  return GRAPH_PERMISSIONS.filter((permission) => granted.has(permission.toLowerCase()));
}

/** What an agent is given: a Graph access token and when it stops working, never the refresh token behind it. */
export interface MicrosoftAccessToken {
  access_token: string;
  /** ISO 8601. */
  expires_at: string;
  /** The Graph permissions it carries, short names. */
  permissions: string[];
}

/**
 * Entra answers seconds-to-live; the agent is told a time instead, a minute early, so a token it caches is never sent
 * in the last moments of its life.
 */
export function accessTokenView(accessToken: string, expiresIn: number | undefined, scope: string, now: number): MicrosoftAccessToken {
  const lifetime = Math.max(0, (expiresIn ?? 3600) - 60);
  return { access_token: accessToken, expires_at: new Date(now + lifetime * 1000).toISOString(), permissions: grantedPermissions(scope) };
}

/** Why a refresh came back without a token: the connection is over and only connecting again mends it, or it is not. */
export type RefreshFailure = "reconnect" | "unavailable";

/**
 * `invalid_grant` is a refresh token Entra will no longer redeem — revoked, expired after 90 days unused, a password
 * change, consent withdrawn — and `interaction_required` / `consent_required` one that needs the person in a browser.
 * Either way the stored one is dead. Anything else is Entra or the network, which a retry can get past.
 */
export function refreshFailure(error: string | undefined): RefreshFailure {
  return error === "invalid_grant" || error === "interaction_required" || error === "consent_required" ? "reconnect" : "unavailable";
}

/** Where Connect posts to: the start of the connect sign-in. */
export const CONNECT_PATH = "/auth/microsoft/connect";

/** How a connect that came back without a connection ended, as the settings address carries it back. */
export type ConnectOutcome = "cancelled" | "failed";

export const CONNECT_OUTCOME_PARAMETER = "microsoft";

/** What the Microsoft 365 row says about a connect that came back without one. */
export const CONNECT_OUTCOME_WORDS: Record<ConnectOutcome, string> = {
  cancelled: "Microsoft 365 wasn't connected, because it was cancelled at Microsoft. Press Connect to try again.",
  failed: "Microsoft 365 couldn't be connected. Press Connect to try again."
};

export function isConnectOutcome(value: string | null): value is ConnectOutcome {
  return value === "cancelled" || value === "failed";
}

/**
 * How Entra's `error` on a connect callback reads: `access_denied` is the person declining or cancelling at Microsoft,
 * and anything else is a connect that failed.
 */
export function connectOutcome(error: string): ConnectOutcome {
  return error === "access_denied" ? "cancelled" : "failed";
}

/** The address a connect returns to when it ended without a connection: the page it began on, saying how. */
export function withConnectOutcome(returnTo: string, outcome: ConnectOutcome): string {
  const [path, query = ""] = returnTo.split("?", 2) as [string, string?];
  const search = new URLSearchParams(query);
  search.set(CONNECT_OUTCOME_PARAMETER, outcome);
  return `${path}?${search}`;
}
