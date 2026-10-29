/**
 * The app's URL layout: where `/` goes, and where the hub's pages sit. Pure, because both are wrong quietly. The
 * first decides whether every other page is reachable; the second is read by `src/proxy.ts`, where its order against
 * the secret-in-query guard decides whether a pasted secret reaches a `Location` header.
 */

/** The hub's own pages all sit under this prefix, so `/` is free for the default UI. */
const HUB = "/hub";

const ASSISTANT = "/assistant";

/** Where a person manages the only access anyone grants anyone: a read of one of their conversations. */
const SHARED_CHATS = `${ASSISTANT}/shared`;

/**
 * The HMCTS Assistant is the default UI, so `/` is the Assistant wherever it runs. It runs on a virtual agent, and
 * its pages answer 404 while virtual agents are off, so those deployments get the hub instead.
 */
export function defaultUi(virtualAgents: boolean): string {
  return virtualAgents ? ASSISTANT : HUB;
}

/**
 * Every first segment the hub answers on besides `/hub` itself. These are the addresses people paste into chats and
 * tickets — `/agents/{id}` is the one URL for any agent, local or virtual — so a 404 on one is a regression even
 * though no code links to them.
 */
const MOVED_SEGMENTS = new Set(["agents", "c", "channels", "m", "settings", "topics", "virtual"]);

/**
 * Where a bare hub address is served from, or `undefined` when the path is not one. Matches a whole first segment, so
 * `/topicsfoo` is left alone and `/hub/topics` cannot match itself into a redirect loop.
 */
export function movedHubPath(pathname: string): string | undefined {
  const [, segment] = pathname.split("/");
  return segment !== undefined && MOVED_SEGMENTS.has(segment) ? `${HUB}${pathname}` : undefined;
}

/**
 * Where a retired hub address goes now, or `undefined` when the path is not one.
 *
 * `/hub/access` managed one person's standing grants over every agent they own. There are none to manage: an agent is
 * its owner's, somebody else's is reached by tagging it in a post, and the only access anyone grants anyone is a read
 * of one conversation at a time — which that page already linked to and which is managed at `SHARED_CHATS`. So that
 * is where it goes, except where virtual agents are off: there are no conversations to share there either, and the
 * Assistant's pages are not found at all, so it gets the hub's home instead.
 *
 * Both the bare address and the `/hub` one, because the page existed under both and both were pasted into tickets.
 * Checked ahead of `movedHubPath`, which would otherwise send the bare one to a page that is no longer there.
 */
export function retiredHubPath(pathname: string, virtualAgents: boolean): string | undefined {
  if (pathname !== "/access" && pathname !== `${HUB}/access`) {
    return undefined;
  }
  return virtualAgents ? SHARED_CHATS : HUB;
}

/**
 * The way back a 404 offers. A mistyped hub address gets the hub, not the Assistant: the not-found page renders
 * outside the hub's layout, so this link is the only way back into it.
 */
export function homeFor(pathname: string): string {
  return pathname === HUB || pathname.startsWith(`${HUB}/`) ? HUB : "/";
}
