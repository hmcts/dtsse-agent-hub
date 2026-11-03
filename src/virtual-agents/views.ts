import type { CredentialKind } from "../credentials/names.ts";
import { viewerUrl } from "../port-viewer/paths.ts";
import { viewerSettings } from "../port-viewer/settings.ts";
import type { ModelRoute } from "../viewer/identity.ts";
import { publicUrl } from "./ports.ts";
import { publicDomain } from "./settings.ts";
import type { VirtualAgentRow } from "./store.ts";

/** A port the pod reports listening on beyond loopback, with the URL it is served at on the VPN and, with the viewer on, the one it is served at off it. */
export interface PortLink {
  port: number;
  url: string;
  viewerUrl?: string;
}

function viewerLink(id: string, port: number, host: string | undefined): { viewerUrl?: string } {
  return host === undefined ? {} : { viewerUrl: viewerUrl(host, id, port) };
}

/** Where each port the pod reports can be opened: its VPN URL, and with the viewer on, the viewer's too. */
export function portLinks(row: Pick<VirtualAgentRow, "id" | "statefulsetName" | "exposedPorts" | "localOnlyPorts">): {
  exposedPorts: PortLink[];
  localOnlyPorts: number[];
} {
  const viewerHost = viewerSettings()?.host;
  return {
    exposedPorts: row.exposedPorts.map((port) => ({
      port,
      url: publicUrl(row.statefulsetName, port, publicDomain()),
      ...viewerLink(row.id, port, viewerHost)
    })),
    localOnlyPorts: row.localOnlyPorts
  };
}

/**
 * An Azure sign-in only lets the agent run `az` as its owner (and gives Jenkins their object id), a Jenkins API token
 * only adds the Jenkins tools, and an Atlassian sign-in only the `twg` CLI for Jira and Confluence, so the pod never
 * waits for any of them. Azure is signed in to only when the owner asks, from the Assistant's settings.
 *
 * On the `gateway` route Azure is not one of these: `az` is where that route's model credential comes from, so it is
 * needed rather than optional there, its pod relays a sign-in at boot whenever none it has works, and
 * `optionalCredentials` is what keeps it out of both lists at once.
 */
export const OPTIONAL_CREDENTIALS: CredentialKind[] = ["azure", "jenkins", "atlassian"];

/**
 * What each route's pod cannot boot without, as a table over the whole union: a route added without an entry does not
 * build, rather than quietly falling through to another route's credentials.
 *
 * `gateway` needs no model credential of its own. The gateway authorises the owner's own Azure sign-in, so `az` is
 * the credential and `github` the only other thing the pod waits for.
 */
const NEEDED: Readonly<Record<ModelRoute, readonly CredentialKind[]>> = {
  gateway: ["github", "azure"],
  "own-licence": ["github", "claude"]
};

export function neededCredentials(route: ModelRoute): CredentialKind[] {
  return [...NEEDED[route]];
}

/** What the route can use if stored but starts without: the optional kinds it does not already need. */
export function optionalCredentials(route: ModelRoute): CredentialKind[] {
  const needed = NEEDED[route];
  return OPTIONAL_CREDENTIALS.filter((kind) => !needed.includes(kind));
}

/**
 * Whether a Claude token is any use to this person, which is what decides whether they may store one.
 *
 * An agent's route is fixed on its row when it is created, and its pod boots on that; the person's own route follows
 * their `AIGateway.User` app role, read fresh at each sign-in. So the two disagree for as long as it takes someone
 * granted or losing that role to replace their agents, and the agents are what needs the token. Their own route
 * stands in for the agent they have not created yet, which would be made on the route they are on now.
 */
export function claudeTokenUsable(viewerRoute: ModelRoute, agentRoutes: readonly ModelRoute[]): boolean {
  return viewerRoute === "own-licence" || agentRoutes.includes("own-licence");
}
