import type { CredentialKind } from "../credentials/names.ts";
import type { CredentialStatus } from "../credentials/store.ts";
import type { ModelRoute } from "../viewer/identity.ts";

/**
 * The person's saved credentials as the Assistant's Connections section lists them: which can be pasted, which can
 * be removed, and what removing each ends. Pure, so the rules are tested apart from the form.
 *
 * The settings paste a Jenkins API token, and a Claude token while any agent of the person's is on their own licence.
 * GitHub, the Azure token cache and the Atlassian sign-in only ever come from a pod's own device-code sign-in here, and
 * a Microsoft 365 connection only from the hub's own Connect, so they are removed here and never pasted. Every stored
 * one can be removed. `saveCredential` still accepts a GitHub token, because the published client's boot script tells
 * an owner whose device sign-in did not finish to paste one; the settings offer no box for it.
 */

/** The kinds the section is about: every credential but the CLAUDE.md and the git identity, which have sections of their own. */
export const SAVED_KINDS = ["github", "azure", "claude", "jenkins", "atlassian", "microsoft"] as const satisfies readonly CredentialKind[];

export type SavedKind = (typeof SAVED_KINDS)[number];

const TITLES: Record<SavedKind, string> = {
  github: "GitHub token",
  azure: "Azure sign-in",
  claude: "Claude token",
  jenkins: "Jenkins API token",
  atlassian: "Atlassian sign-in",
  microsoft: "Microsoft 365 connection"
};

export interface SavedCredential {
  kind: SavedKind;
  title: string;
  stored: boolean;
  /** The account a sign-in is for, when the hub recorded one. */
  accountLabel: string | null;
  pasteable: boolean;
  /** Asked before a removal is sent: what it ends. */
  removeQuestion: string;
}

function pasteable(kind: SavedKind, claudeTokenUsable: boolean): boolean {
  return kind === "jenkins" || (kind === "claude" && claudeTokenUsable);
}

/** `route` is the assistant's own, which decides whether its Claude comes through Azure or through a Claude token. */
function removeQuestion(kind: SavedKind, route: ModelRoute): string {
  const ask = `Remove your ${TITLES[kind]}?`;
  if (kind === "claude" && route === "own-licence") {
    return `${ask} Your assistant reaches Claude with it, so it cannot answer again until you paste a new one.`;
  }
  if (kind === "azure" && route === "gateway") {
    return `${ask} Your assistant reaches Claude through it, so it cannot answer again until you sign in to Azure again.`;
  }
  if (kind === "microsoft") {
    return `${ask} Your agents can no longer read your mail, calendar, Teams chats, meetings or files until you connect again.`;
  }
  if (kind === "github") {
    return `${ask} Your assistant cannot reach GitHub until you sign in to GitHub again.`;
  }
  return `${ask} Your assistant stops using it the next time it starts.`;
}

/** One row per kind that is stored or can be pasted; a sign-in that is neither has nothing to do here. */
export function savedCredentials(statuses: readonly CredentialStatus[], route: ModelRoute, claudeTokenUsable: boolean): SavedCredential[] {
  return SAVED_KINDS.flatMap((kind) => {
    const status = statuses.find((candidate) => candidate.kind === kind);
    const stored = status?.stored === true;
    const canPaste = pasteable(kind, claudeTokenUsable);
    if (!stored && !canPaste) {
      return [];
    }
    return [
      { kind, title: TITLES[kind], stored, accountLabel: status?.accountLabel ?? null, pasteable: canPaste, removeQuestion: removeQuestion(kind, route) }
    ];
  });
}

/**
 * The section's rows out of what a page already read for the getting-ready screen, or why there are none: credentials
 * the hub cannot read are not the same as none saved.
 */
export function savedCredentialsData(
  credentials: { claudeTokenUsable: boolean } & ({ available: true; statuses: CredentialStatus[] } | { available: false; reason: string }),
  route: ModelRoute
): { rows: SavedCredential[]; unavailable: string | null } {
  return credentials.available
    ? { rows: savedCredentials(credentials.statuses, route, credentials.claudeTokenUsable), unavailable: null }
    : { rows: [], unavailable: credentials.reason };
}
