import type { CredentialKind } from "../credentials/names.ts";
import type { ModelRoute } from "../viewer/identity.ts";

/**
 * The sign-ins a pod holds for itself from its start, and which of the owner's agents use each: a Claude token only
 * reaches Claude for an agent on the person's own licence, so an agent on the gateway holds none to stop using. Pure,
 * so the removal question the settings ask and the restart the removal does read the same rule.
 */
export const HELD_BY: Partial<Record<CredentialKind, "every" | "own-licence">> = {
  github: "every",
  azure: "every",
  atlassian: "every",
  jenkins: "every",
  claude: "own-licence"
};

/** Whether removing `kind` restarts a running agent on `route`, since it would otherwise go on using it. */
export function restartsOnRemoval(kind: CredentialKind, route: ModelRoute): boolean {
  const users = HELD_BY[kind];
  return users === "every" || (users === "own-licence" && route === "own-licence");
}
