import { canOpenVirtualAgentPort, feedbackLinkAccess } from "../access/rules.ts";
import type { Environment } from "../auth/settings.ts";
import { checkTargetUrl } from "../feedback/targets.ts";
import { publicUrl } from "../virtual-agents/ports.ts";
import { declaresTooLongBody, type Fetch, forward, isRewritableHtml, PROXY_BODY_LIMIT_BYTES, UpstreamUnreachable } from "./forward.ts";
import {
  AUTH_PATH,
  feedbackCookieName,
  feedbackPrefix,
  isFeedbackPath,
  LAST_PORT_COOKIE,
  landingPath,
  lastFeedbackCookie,
  lastPortCookie,
  lastPortTarget,
  parseViewerPath,
  refererTarget,
  reviewPath,
  TICKET_PARAMETER,
  ticketPath,
  viewerCookieName,
  viewerPrefix
} from "./paths.ts";
import { type ViewerSettings, viewerSettings } from "./settings.ts";
import {
  openFeedbackCookie,
  openFeedbackTicket,
  openTicket,
  openViewerCookie,
  sealFeedbackCookie,
  sealFeedbackTicket,
  sealTicket,
  sealViewerCookie,
  VIEWER_COOKIE_MAX_AGE
} from "./tickets.ts";
import { type WidgetBundle, widgetSnippet } from "./widget.ts";

/**
 * Every request to the viewer's host: the ticket exchange, the bounce through the hub for a person without a cookie,
 * forwarding for one with, and the feedback widget's bundle. The route handler only supplies the stores and `fetch`.
 */

/** What the viewer reads of a virtual agent on every request, so a deletion or a port going shuts it at once. */
export interface ViewerAgent {
  id: string;
  ownerOid: string;
  desired: string;
  statefulsetName: string;
  exposedPorts: number[];
}

/** What the viewer reads of a feedback link on every request, so revoking it or archiving its project shuts it at once. */
export interface ViewerFeedbackLink {
  token: string;
  /** The prototype's origin, which is all the viewer ever fetches for the link. */
  origin: string;
  prototypeVersion: string | null;
  revokedAt: Date | null;
  project: { ownerOid: string; archivedAt: Date | null; maskInputs: boolean };
  memberOids: string[];
}

/** Present only while feedback is on; without it every feedback path and the widget are not found. */
export interface FeedbackDependencies {
  findLink: (token: string) => Promise<ViewerFeedbackLink | null | undefined>;
  /** Whether every address the prototype's host resolves to is public (`resolvesPublic`, cached). */
  resolvesPublic: (hostname: string) => Promise<boolean>;
  readWidget: () => Promise<WidgetBundle | undefined>;
  /** A fresh nonce for each page's widget script. */
  nonce?: () => string;
  env?: Environment;
}

export interface ViewerDependencies {
  settings: ViewerSettings;
  /** `VIRTUAL_AGENT_PUBLIC_DOMAIN`, which the pod's ingress hosts are under. */
  publicDomain: string;
  loadAgent: (id: string) => Promise<ViewerAgent | undefined>;
  fetch: Fetch;
  feedback?: FeedbackDependencies;
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

/**
 * The hub's framing headers, which every viewer answer carries but a feedback link's: nothing may frame an agent's
 * web server. They replace whatever the pod sent, since the pod's own choice is not the viewer's.
 */
export function denyFraming(response: Response): Response {
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("content-security-policy", "frame-ancestors 'none'");
  return response;
}

/**
 * A feedback answer, which the hub's review page frames: no `X-Frame-Options`, and `frame-ancestors` the hub alone.
 * A forwarded page has had its own policy rewritten to say so already; the viewer's own answers get just that.
 */
function framedByHub(response: Response, hubOrigin: string): Response {
  response.headers.delete("x-frame-options");
  if (!response.headers.has("content-security-policy")) {
    response.headers.set("content-security-policy", `frame-ancestors ${hubOrigin}`);
  }
  return response;
}

/** Whether the agent still serves `port` to `oid`: they own it, it is not being deleted, and the pod reports the port. */
export function stillServed(agent: ViewerAgent | undefined, oid: string, port: number): agent is ViewerAgent {
  return agent !== undefined && canOpenVirtualAgentPort(oid, agent) && agent.desired !== "deleted" && agent.exposedPorts.includes(port);
}

/** Whether the link is still open to `oid`: not revoked, its project not archived, and theirs to review or work on. */
export function stillLive(link: ViewerFeedbackLink | null | undefined, oid: string): link is ViewerFeedbackLink {
  return link !== null && link !== undefined && feedbackLinkAccess(oid, link, link.memberOids) !== "none";
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

/**
 * The review page's half of the hand-off: the `src` of the frame that shows the feedback link `token` to `identity`,
 * landing on `path` under the link's prefix, or `undefined` while the viewer is off. The caller has already found the
 * link and checked `feedbackLinkAccess`; the viewer checks both again on every request the frame makes.
 */
export async function feedbackTicketUrl(
  identity: { oid: string },
  token: string,
  path: string | null,
  settings: ViewerSettings | undefined = viewerSettings(),
  now?: Date
): Promise<string | undefined> {
  if (settings === undefined) {
    return undefined;
  }
  const ticket = await sealFeedbackTicket({ oid: identity.oid, token, path: landingPath(path) }, settings.secret, now);
  return `https://${settings.host}${AUTH_PATH}?${new URLSearchParams({ [TICKET_PARAMETER]: ticket })}`;
}

function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Buffer.from(bytes).toString("base64url");
}

/** Whether the browser is loading this into a frame, where a redirect to a hub page could never be shown. */
function framed(request: Request): boolean {
  const destination = request.headers.get("sec-fetch-dest");
  return destination === "iframe" || destination === "frame";
}

export async function serveViewer(request: Request, pathAndQuery: string, deps: ViewerDependencies): Promise<Response> {
  const { response, hubFramed } = await answer(request, pathAndQuery, deps);
  return hubFramed ? framedByHub(response, deps.settings.hubOrigin) : denyFraming(response);
}

async function answer(request: Request, pathAndQuery: string, deps: ViewerDependencies): Promise<{ response: Response; hubFramed: boolean }> {
  const { settings } = deps;
  const target = parseViewerPath(pathAndQuery);
  const deny = (response: Response) => ({ response, hubFramed: false });

  switch (target.kind) {
    case "none": {
      // A root-relative URL from a port's or a feedback link's page: sent back under that page's prefix, where its
      // own cookie and checks apply as to any other request. 307 keeps the method and body, so a form posted to
      // `/submit` arrives. Failing that, the prefix whose page was last served here, for a single-page app that has
      // left its prefix.
      const location =
        refererTarget(request.headers.get("referer"), settings.host, pathAndQuery) ??
        lastPortTarget(cookieValue(request.headers.get("cookie"), LAST_PORT_COOKIE), pathAndQuery);
      if (location !== undefined) {
        return { response: new Response(null, { status: 307, headers: { ...NO_STORE, location } }), hubFramed: isFeedbackPath(location) };
      }
      return deny(text(404, "Not found"));
    }

    case "widget":
      return deny(await serveWidget(request, deps.feedback));

    case "bare-port":
      return deny(new Response(null, { status: 308, headers: { location: `${viewerPrefix(target.virtualAgentId, target.port)}/${target.search}` } }));

    case "bare-feedback":
      if (deps.feedback === undefined) {
        return deny(text(404, "Not found"));
      }
      return { response: new Response(null, { status: 308, headers: { location: `${feedbackPrefix(target.token)}/${target.search}` } }), hubFramed: true };

    case "auth": {
      const ticket = await openTicket(target.ticket, settings.secret);
      if (ticket !== undefined) {
        const prefix = viewerPrefix(ticket.virtualAgentId, ticket.port);
        const cookie = await sealViewerCookie(ticket, settings.secret, deps.now?.());
        return deny(
          seeOther(`${prefix}${landingPath(ticket.path)}`, {
            "set-cookie": viewerCookie(viewerCookieName(ticket.virtualAgentId, ticket.port), cookie, prefix)
          })
        );
      }
      if (deps.feedback === undefined) {
        return deny(text(400, "This link has expired. Open the web server again from Web servers in your CFT Workspace settings."));
      }
      const feedbackTicket = await openFeedbackTicket(target.ticket, settings.secret);
      if (feedbackTicket === undefined) {
        // Framed by the hub, since a review page's frame starts here and a refusal the browser will not show helps nobody.
        return { response: text(400, "This link has expired. Reload the page you opened it from."), hubFramed: true };
      }
      const prefix = feedbackPrefix(feedbackTicket.token);
      const cookie = await sealFeedbackCookie(feedbackTicket, settings.secret, deps.now?.());
      return {
        response: seeOther(`${prefix}${landingPath(feedbackTicket.path)}`, {
          "set-cookie": viewerCookie(feedbackCookieName(feedbackTicket.token), cookie, prefix)
        }),
        hubFramed: true
      };
    }

    case "port": {
      const { virtualAgentId, port, rest, search } = target;
      const grant = await openViewerCookie(cookieValue(request.headers.get("cookie"), viewerCookieName(virtualAgentId, port)), settings.secret);
      if (grant === undefined || grant.virtualAgentId !== virtualAgentId || grant.port !== port) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return deny(text(401, "Open this web server from Web servers in your CFT Workspace settings first."));
        }
        return deny(seeOther(`${settings.hubOrigin}${ticketPath(virtualAgentId, port, `${rest}${search}`)}`));
      }
      const agent = await deps.loadAgent(virtualAgentId);
      if (!stillServed(agent, grant.oid, port)) {
        return deny(text(404, `Nothing is being served on port ${port} of this agent.`));
      }
      if (declaresTooLongBody(request.headers)) {
        return deny(
          text(
            413,
            `The viewer cannot carry a request body larger than ${PROXY_BODY_LIMIT_BYTES / (1024 * 1024)} MiB. Reach the web server over the VPN to send this.`
          )
        );
      }
      try {
        const response = await forward(
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
        if (response.ok && isRewritableHtml(response.headers)) {
          response.headers.append("set-cookie", lastPortCookie(virtualAgentId, port, VIEWER_COOKIE_MAX_AGE));
        }
        return deny(response);
      } catch (error) {
        if (error instanceof UpstreamUnreachable) {
          return deny(text(502, `The web server on port ${port} did not answer.`));
        }
        throw error;
      }
    }

    case "feedback": {
      const response = deps.feedback === undefined ? text(404, "Not found") : await serveFeedback(request, target, deps, deps.feedback);
      return { response, hubFramed: deps.feedback !== undefined };
    }
  }
}

async function serveWidget(request: Request, feedback: FeedbackDependencies | undefined): Promise<Response> {
  const widget = feedback === undefined ? undefined : await feedback.readWidget();
  if (widget === undefined) {
    return text(404, "Not found");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { ...NO_STORE, allow: "GET, HEAD" } });
  }
  const headers = {
    "content-type": "text/javascript; charset=utf-8",
    // Revalidated every time, so a new bundle reaches every open review at its next page load.
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    etag: widget.etag
  };
  if (request.headers.get("if-none-match") === widget.etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : widget.body, { headers });
}

async function serveFeedback(
  request: Request,
  target: { token: string; rest: string; search: string },
  deps: ViewerDependencies,
  feedback: FeedbackDependencies
): Promise<Response> {
  const { settings } = deps;
  const { token, rest, search } = target;
  const grant = await openFeedbackCookie(cookieValue(request.headers.get("cookie"), feedbackCookieName(token)), settings.secret);
  if (grant === undefined || grant.token !== token) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return text(401, "Open this prototype from its feedback link first.");
    }
    if (framed(request)) {
      return text(401, "Your review has timed out. Reload the page to carry on.");
    }
    return seeOther(`${settings.hubOrigin}${reviewPath(token, `${rest}${search}`)}`);
  }
  const link = await feedback.findLink(token);
  if (!stillLive(link, grant.oid)) {
    return text(404, "This feedback link is no longer open.");
  }
  if (declaresTooLongBody(request.headers)) {
    return text(413, `The viewer cannot carry a request body larger than ${PROXY_BODY_LIMIT_BYTES / (1024 * 1024)} MiB.`);
  }
  const checked = checkTargetUrl(link.origin, feedback.env);
  if (!checked.ok || !(await feedback.resolvesPublic(checked.hostname))) {
    return text(502, "The prototype's address is not one the hub may reach.");
  }
  const prefix = feedbackPrefix(token);
  const nonce = (feedback.nonce ?? newNonce)();
  try {
    const response = await forward(
      request,
      {
        upstreamOrigin: checked.origin,
        rest,
        search,
        prefix,
        viewerHost: settings.host,
        frameAncestors: settings.hubOrigin,
        scriptNonce: nonce,
        inject: widgetSnippet({
          hubOrigin: settings.hubOrigin,
          prefix,
          upstreamOrigin: checked.origin,
          maskInputs: link.project.maskInputs,
          prototypeVersion: link.prototypeVersion,
          nonce
        })
      },
      deps.fetch
    );
    if (response.ok && isRewritableHtml(response.headers)) {
      response.headers.append("set-cookie", lastFeedbackCookie(token, VIEWER_COOKIE_MAX_AGE));
    }
    return response;
  } catch (error) {
    if (error instanceof UpstreamUnreachable) {
      return text(502, "The prototype did not answer.");
    }
    throw error;
  }
}
