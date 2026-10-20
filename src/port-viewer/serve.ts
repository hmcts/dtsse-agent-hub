import { canOpenVirtualAgentPort } from "../access/rules.ts";
import { publicUrl } from "../virtual-agents/ports.ts";
import { type Fetch, forward, UpstreamUnreachable } from "./forward.ts";
import { AUTH_PATH, landingPath, parseViewerPath, TICKET_PARAMETER, ticketPath, viewerCookieName, viewerPrefix } from "./paths.ts";
import type { ViewerSettings } from "./settings.ts";
import { openTicket, openViewerCookie, sealTicket, sealViewerCookie, VIEWER_COOKIE_MAX_AGE } from "./tickets.ts";

/**
 * Every request to the viewer's host: the ticket exchange, the bounce through the hub for a person without a cookie,
 * and forwarding for one with. The route handler only supplies the store and `fetch`.
 */

/** What the viewer reads of a virtual agent on every request, so a deletion or a port going shuts it at once. */
export interface ViewerAgent {
  id: string;
  ownerOid: string;
  desired: string;
  statefulsetName: string;
  exposedPorts: number[];
}

export interface ViewerDependencies {
  settings: ViewerSettings;
  /** `VIRTUAL_AGENT_PUBLIC_DOMAIN`, which the pod's ingress hosts are under. */
  publicDomain: string;
  loadAgent: (id: string) => Promise<ViewerAgent | undefined>;
  fetch: Fetch;
  now?: () => Date;
}

/** Nothing the viewer itself answers is worth a cache keeping: each depends on who is asking. */
const NO_STORE = { "cache-control": "no-store" };

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, { status, headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8" } });
}

function seeOther(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { ...NO_STORE, location, ...extra } });
}

export function cookieValue(header: string | null, name: string): string | undefined {
  for (const pair of (header ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at !== -1 && pair.slice(0, at).trim() === name) {
      return pair.slice(at + 1).trim();
    }
  }
  return undefined;
}

function viewerCookie(name: string, value: string, prefix: string): string {
  return `${name}=${value}; Path=${prefix}/; Max-Age=${VIEWER_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

/** Whether the agent still serves `port` to `oid`: they own it, it is not being deleted, and the pod reports the port. */
export function stillServed(agent: ViewerAgent | undefined, oid: string, port: number): agent is ViewerAgent {
  return agent !== undefined && canOpenVirtualAgentPort(oid, agent) && agent.desired !== "deleted" && agent.exposedPorts.includes(port);
}

/**
 * The hub's half of the hand-off: where to send a signed-in person who asked to open `port`, or `undefined` when it
 * is not theirs to open, which the hub answers as not found.
 */
export async function ticketUrl(
  viewerOid: string,
  agent: ViewerAgent | undefined,
  port: number,
  path: string | null,
  settings: ViewerSettings,
  now?: Date
): Promise<string | undefined> {
  if (!stillServed(agent, viewerOid, port)) {
    return undefined;
  }
  const ticket = await sealTicket({ oid: viewerOid, virtualAgentId: agent.id, port, path: landingPath(path) }, settings.secret, now);
  return `https://${settings.host}${AUTH_PATH}?${new URLSearchParams({ [TICKET_PARAMETER]: ticket })}`;
}

export async function serveViewer(request: Request, pathAndQuery: string, deps: ViewerDependencies): Promise<Response> {
  const { settings } = deps;
  const target = parseViewerPath(pathAndQuery);

  switch (target.kind) {
    case "none":
      return text(404, "Not found");

    case "bare-port":
      return new Response(null, { status: 308, headers: { location: `${viewerPrefix(target.virtualAgentId, target.port)}/${target.search}` } });

    case "auth": {
      const ticket = await openTicket(target.ticket, settings.secret);
      if (ticket === undefined) {
        return text(400, "This link has expired. Open the web server again from the agent's page on agent-hub.");
      }
      const prefix = viewerPrefix(ticket.virtualAgentId, ticket.port);
      const cookie = await sealViewerCookie(ticket, settings.secret, deps.now?.());
      return seeOther(`${prefix}${landingPath(ticket.path)}`, {
        "set-cookie": viewerCookie(viewerCookieName(ticket.virtualAgentId, ticket.port), cookie, prefix)
      });
    }

    case "port": {
      const { virtualAgentId, port, rest, search } = target;
      const grant = await openViewerCookie(cookieValue(request.headers.get("cookie"), viewerCookieName(virtualAgentId, port)), settings.secret);
      if (grant === undefined || grant.virtualAgentId !== virtualAgentId || grant.port !== port) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return text(401, "Open this web server from the agent's page on agent-hub first.");
        }
        return seeOther(`${settings.hubOrigin}${ticketPath(virtualAgentId, port, `${rest}${search}`)}`);
      }
      const agent = await deps.loadAgent(virtualAgentId);
      if (!stillServed(agent, grant.oid, port)) {
        return text(404, `Nothing is being served on port ${port} of this agent.`);
      }
      try {
        return await forward(
          request,
          {
            upstreamOrigin: publicUrl(agent.statefulsetName, port, deps.publicDomain),
            rest,
            search,
            prefix: viewerPrefix(virtualAgentId, port),
            viewerHost: settings.host
          },
          deps.fetch
        );
      } catch (error) {
        if (error instanceof UpstreamUnreachable) {
          return text(502, `The web server on port ${port} did not answer.`);
        }
        throw error;
      }
    }
  }
}
