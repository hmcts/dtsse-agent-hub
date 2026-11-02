/**
 * The app's URL layout: where `/` goes, and where the hub's pages sit. Pure, because both are wrong quietly. The
 * first decides whether every other page is reachable; the second is read by `src/proxy.ts`, where its order against
 * the secret-in-query guard decides whether a pasted secret reaches a `Location` header.
 */

/** The hub's own pages all sit under this prefix, so `/` is free for the default UI. */
const HUB = "/hub";

const ASSISTANT = "/assistant";

/**
 * The HMCTS Assistant is the default UI, so `/` is the Assistant wherever it runs. It runs on a virtual agent, and
 * its pages answer 404 while virtual agents are off, so those deployments get the hub instead.
 */
export function defaultUi(virtualAgents: boolean): string {
  return virtualAgents ? ASSISTANT : HUB;
}

/**
 * Every first segment the hub answers on besides `/hub` itself. These are the addresses people paste into chats and
 * tickets, so a 404 on one is a regression even though no code links to them.
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
 * The section of the Assistant's settings `?settings=` opens, on any Assistant page. The settings dialog reads the same
 * parameter, so a link made here and the section it opens cannot be spelled two ways.
 */
export const SETTINGS_PARAMETER = "settings";

export function assistantSettingsPath(section: string): string {
  return `${ASSISTANT}?${new URLSearchParams({ [SETTINGS_PARAMETER]: section })}`;
}

/**
 * `search` with every `settings` pair taken out, cut as text rather than rebuilt through `URLSearchParams`, which
 * would re-encode the rest: a channel view's commas, or a space written `%20`.
 */
export function withoutSettingsParameter(search: string): string {
  const kept = search
    .replace(/^\?/, "")
    .split("&")
    .filter((pair) => pair !== "" && pair.split("=")[0] !== SETTINGS_PARAMETER);
  return kept.length === 0 ? "" : `?${kept.join("&")}`;
}

/**
 * Where a person manages who may read or fork their conversations, the only access one person gives another: the
 * settings' Sharing section, whose id in `SECTIONS` this names.
 */
export const SHARED_CHATS = assistantSettingsPath("sharing");

/** `/virtual/{id}` with nothing after the id; the port ticket route under it is still served. */
const VIRTUAL_AGENT_PAGE = /^\/virtual\/[^/]+$/;

/**
 * Where a retired address goes now, or `undefined` when the path is not one. Each goes where what it showed is managed
 * now, and to the hub's home where virtual agents are off and the Assistant's pages are not found.
 *
 * - `/access` goes to `SHARED_CHATS`: an agent is its owner's, somebody else's is reached by tagging it in a post, and
 *   the only access one person gives another is a share or fork of one conversation at a time, which is managed there.
 * - `/assistant/shared` goes there too, an address bookmarked and pasted for the list of shared chats. The
 *   `/assistant/shared/{id}` pages under it are a recipient's view of one chat, and are not retired.
 * - `/virtual` and `/virtual/{id}` go to the Assistant section of its settings: the Assistant's agent is the one
 *   virtual agent a person has, and its settings are where it is renamed, restarted and its web servers opened.
 *   `/virtual/{id}/ports/{port}` is not one of these: it is the viewer's ticket route, and is still served.
 * - `/settings/credentials` goes to Credentials, where a token is pasted: the published client's pod boot messages still
 *   send people there to paste their GitHub token.
 *
 * Both the bare address and the `/hub` one for the hub's pages, because each existed under both and both were pasted
 * into tickets. Checked ahead of `movedHubPath`, which would otherwise send the bare one to a page that is no longer
 * there.
 */
export function retiredPath(pathname: string, virtualAgents: boolean): string | undefined {
  const path = pathname.startsWith(`${HUB}/`) ? pathname.slice(HUB.length) : pathname;
  const to =
    path === "/access" || pathname === `${ASSISTANT}/shared`
      ? SHARED_CHATS
      : path === "/virtual" || VIRTUAL_AGENT_PAGE.test(path)
        ? assistantSettingsPath("assistant")
        : path === "/settings/credentials"
          ? assistantSettingsPath("credentials")
          : undefined;
  return to === undefined ? undefined : virtualAgents ? to : HUB;
}

/**
 * What an agent's address names, as far as where it goes now: one of the viewer's own chats in the Assistant, one of
 * their virtual agents or a session of one, or anything else. Somebody else's agent is anything else, so where the
 * address goes says nothing about whether it exists.
 */
export type AgentAddress = { kind: "chat"; conversationId: string } | { kind: "virtual"; assistant: boolean } | { kind: "none" };

export const NO_AGENT: AgentAddress = { kind: "none" };

/**
 * Where `/hub/agents/{id}` goes. The hub shows no agents: a chat's agent is that chat in the Assistant, and a virtual
 * agent, or a session of one, goes to the Assistant: to the Assistant section of its settings when it is the agent the
 * Assistant runs on, which is the one that section shows and restarts, and to the Assistant itself for any other, which
 * nothing there manages. Anything else goes to the hub's home, and so does everything where virtual agents are off,
 * since the Assistant's pages are not found there.
 */
export function retiredAgentPath(address: AgentAddress, virtualAgents: boolean): string {
  if (!virtualAgents || address.kind === "none") {
    return HUB;
  }
  if (address.kind === "chat") {
    return `${ASSISTANT}/${encodeURIComponent(address.conversationId)}`;
  }
  return address.assistant ? assistantSettingsPath("assistant") : ASSISTANT;
}

/**
 * The way back a 404 offers. A mistyped hub address gets the hub, not the Assistant: the not-found page renders
 * outside the hub's layout, so this link is the only way back into it.
 */
export function homeFor(pathname: string): string {
  return pathname === HUB || pathname.startsWith(`${HUB}/`) ? HUB : "/";
}
