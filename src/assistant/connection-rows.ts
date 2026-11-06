import type { ModelRoute } from "../viewer/identity.ts";
import {
  CONNECTION_DETAILS,
  type Connection,
  type ConnectionState,
  connectorFor,
  isConnection,
  type MicrosoftConnection,
  type ModelAccess,
  modelAccessAfter
} from "./connections.ts";
import type { SavedCredential } from "./saved-credentials.ts";

/**
 * The Connections list of the Assistant's settings: one row per service, carrying both the sign-in the assistant makes
 * for it and the credential saved for it, so a service is never listed twice. Pure: the dialog renders what
 * `connectionRows` returns, and which actions a row offers is read from the halves it carries.
 */
export interface ConnectionRow {
  /** The credential kind, or `model-access` for the derived row saying how the agents reach Claude. */
  key: string;
  name: string;
  /** The letters the list shows in place of a logo. */
  initial: string;
  /** The account the row is for when the hub recorded one, otherwise what the service is for. */
  desc: string;
  state: ConnectionState;
  detail: string;
  /** The sign-in, where the person's assistant asks for one: what its Connect is offered from. */
  signIn: Connection | null;
  /** The saved credential, where one can be pasted or is stored to remove. */
  saved: SavedCredential | null;
  /** Microsoft 365, which is connected in the hub's own browser sign-in rather than by the assistant. */
  microsoft: MicrosoftConnection | null;
}

const MICROSOFT_DESC = "Your mail, calendar, Teams chats and meetings, and OneDrive and SharePoint files (optional)";

function signInRow(connection: Connection, saved: SavedCredential | null): ConnectionRow {
  return {
    key: connection.kind,
    name: connection.name,
    initial: connection.initial,
    desc: connection.accountLabel ?? connection.desc,
    state: connection.state,
    detail: connection.detail,
    signIn: connection,
    saved,
    microsoft: null
  };
}

/**
 * The derived model-access row. On the `gateway` route it stands for Claude, so a Claude token still saved from the
 * other route is removed from here rather than from a second row named Claude.
 */
function accessRow(access: ModelAccess, saved: SavedCredential | null): ConnectionRow {
  return { key: "model-access", ...access, signIn: null, saved, microsoft: null };
}

/** A credential saved for a service the assistant does not sign in to: connected while it is stored. */
function savedRow(saved: SavedCredential & { kind: Exclude<SavedCredential["kind"], "microsoft"> }, route: ModelRoute): ConnectionRow {
  const connector = connectorFor(saved.kind, route);
  const state: ConnectionState = saved.stored ? "connected" : "waiting";
  return {
    key: saved.kind,
    name: connector.name,
    initial: connector.initial,
    desc: saved.accountLabel ?? connector.desc,
    state,
    detail: CONNECTION_DETAILS[state],
    signIn: null,
    saved,
    microsoft: null
  };
}

/** What a connection says when its holder may not connect Microsoft 365: their next sign-in deletes it. */
export const MICROSOFT_ENDING = "Removed when you next sign in";

/**
 * A stored connection is connected only for someone who may connect it. Anyone else's is deleted at their next
 * sign-in, so it is not shown as a healthy connection meanwhile, though it keeps its Disconnect.
 */
function microsoftRow(microsoft: MicrosoftConnection): ConnectionRow {
  const state: ConnectionState = microsoft.stored && microsoft.connectable ? "connected" : "waiting";
  return {
    key: "microsoft",
    name: "Microsoft 365",
    initial: "M",
    desc: microsoft.accountLabel ?? MICROSOFT_DESC,
    state,
    detail: microsoft.stored && !microsoft.connectable ? MICROSOFT_ENDING : CONNECTION_DETAILS[state],
    signIn: null,
    saved: null,
    microsoft
  };
}

/**
 * The sign-ins in the order `connections` gives them, the model-access row where `modelAccessAfter` puts it, then any
 * credential saved for a service no sign-in is listed for, then Microsoft 365. The saved Microsoft 365 credential is
 * the connection its row disconnects, so it is never a row of its own.
 */
export function connectionRows(
  list: readonly Connection[],
  access: ModelAccess | null,
  saved: readonly SavedCredential[],
  microsoft: MicrosoftConnection | null,
  route: ModelRoute
): ConnectionRow[] {
  const savedFor = (kind: string) => saved.find((row) => row.kind === kind) ?? null;
  const listed = (kind: string) => list.some((row) => row.kind === kind);
  const accessSaved = access === null || listed("claude") ? null : savedFor("claude");
  const rows: ConnectionRow[] = [];
  list.forEach((connection, index) => {
    rows.push(signInRow(connection, savedFor(connection.kind)));
    if (access !== null && modelAccessAfter(index)) {
      rows.push(accessRow(access, accessSaved));
    }
  });
  for (const row of saved) {
    if (row.kind !== "microsoft" && isConnection(row.kind) && !listed(row.kind) && row !== accessSaved) {
      rows.push(savedRow({ ...row, kind: row.kind }, route));
    }
  }
  if (microsoft !== null) {
    rows.push(microsoftRow(microsoft));
  }
  return rows;
}
