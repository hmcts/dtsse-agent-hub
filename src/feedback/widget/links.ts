/**
 * Keeping the frame's navigation under the link's prefix. The proxy moves a prototype's root-relative links back under
 * `/f/<token>/` itself, but a link written with the prototype's own absolute origin would leave the viewer, and the
 * frame's sandbox refuses `target="_top"` outright; both are caught here, as the browser is about to follow them.
 */

export interface FrameContext {
  /** `/f/<token>`. */
  prefix: string;
  /** The prototype's own origin, whose absolute URLs belong under `prefix`. */
  upstreamOrigin: string;
  /** The frame's origin: the viewer's host. */
  frameOrigin: string;
}

/** The page's path and query under the prefix, from `/`, as a thread's `page_path` is. */
export function pagePathOf(location: { pathname: string; search: string }, prefix: string): string {
  const { pathname, search } = location;
  if (pathname === prefix) {
    return `/${search}`;
  }
  const rest = pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : pathname;
  return `${rest}${search}`;
}

/** `url` moved under the prefix on the frame's origin when it is on the prototype's origin, else `undefined`. */
export function rewriteToFrame(href: string, base: string, context: FrameContext): string | undefined {
  if (!URL.canParse(href, base)) {
    return undefined;
  }
  const url = new URL(href, base);
  if (url.origin !== context.upstreamOrigin) {
    return undefined;
  }
  return `${context.frameOrigin}${context.prefix}${url.pathname}${url.search}${url.hash}`;
}

export type LinkAction = { kind: "none" } | { kind: "assign"; url: string } | { kind: "open"; url: string };

/** Whether a link `target` is one the sandbox would refuse because it names the shell rather than the frame. */
function escapesFrame(target: string): boolean {
  return target === "_top" || target === "_parent";
}

/**
 * What to do with a click on a link: follow it in this frame, open it in a new tab, or leave the browser to it.
 * `newTab` is a click the browser would open in a new tab anyway, by its target or a modifier key.
 */
export function linkAction(href: string, target: string, base: string, context: FrameContext, newTab: boolean): LinkAction {
  const rewritten = rewriteToFrame(href, base, context);
  const name = target.trim().toLowerCase();
  if (newTab || name === "_blank") {
    return rewritten === undefined ? { kind: "none" } : { kind: "open", url: rewritten };
  }
  if (escapesFrame(name)) {
    if (rewritten !== undefined) {
      return { kind: "assign", url: rewritten };
    }
    if (!URL.canParse(href, base)) {
      return { kind: "none" };
    }
    const url = new URL(href, base);
    // The frame's own origin is fine to follow in the frame; anywhere else would replace the review, so it gets a tab.
    return url.origin === context.frameOrigin ? { kind: "assign", url: url.href } : { kind: "open", url: url.href };
  }
  return rewritten === undefined ? { kind: "none" } : { kind: "assign", url: rewritten };
}

/** A form's `action` and `target` changed so that submitting it keeps to the frame, or `undefined` for no change. */
export function formRewrite(action: string, target: string, base: string, context: FrameContext): { action?: string; target?: string } | undefined {
  const rewritten = rewriteToFrame(action, base, context);
  const retarget = escapesFrame(target.trim().toLowerCase()) ? "_self" : undefined;
  if (rewritten === undefined && retarget === undefined) {
    return undefined;
  }
  return { ...(rewritten === undefined ? {} : { action: rewritten }), ...(retarget === undefined ? {} : { target: retarget }) };
}

function baseTarget(document: Document): string {
  return document.querySelector("base[target]")?.getAttribute("target") ?? "";
}

/** The `<a>` or `<area>` a click landed in, through any shadow roots on the way. */
function linkIn(event: Event): HTMLAnchorElement | HTMLAreaElement | undefined {
  for (const node of event.composedPath()) {
    if (node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement) {
      return node.hasAttribute("href") ? node : undefined;
    }
  }
  return undefined;
}

/** Catches clicks and submits that would leave the frame, in the capture phase so the prototype's own handlers see the result. */
export function installLinkCapture(view: Window, context: FrameContext): () => void {
  const { document } = view;
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) {
      return;
    }
    const link = linkIn(event);
    if (link === undefined || link.hasAttribute("download")) {
      return;
    }
    const newTab = event.ctrlKey || event.metaKey || event.shiftKey;
    const action = linkAction(link.getAttribute("href") ?? "", link.target || baseTarget(document), document.baseURI, context, newTab);
    if (action.kind === "none") {
      return;
    }
    event.preventDefault();
    if (action.kind === "assign") {
      view.location.assign(action.url);
    } else {
      view.open(action.url, "_blank", "noopener");
    }
  };
  const onSubmit = (event: SubmitEvent) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || event.defaultPrevented) {
      return;
    }
    const submitter = event.submitter instanceof HTMLButtonElement || event.submitter instanceof HTMLInputElement ? event.submitter : null;
    const action = submitter?.getAttribute("formaction") ?? form.getAttribute("action") ?? "";
    const target = submitter?.getAttribute("formtarget") ?? (form.getAttribute("target") || baseTarget(document));
    const change = formRewrite(action === "" ? document.URL : action, target, document.baseURI, context);
    if (change === undefined) {
      return;
    }
    // A submitter's own attributes win over the form's, so the change goes on whichever the browser will read.
    const holder: Element = submitter !== null && (submitter.hasAttribute("formaction") || submitter.hasAttribute("formtarget")) ? submitter : form;
    const prefix = holder === form ? "" : "form";
    if (change.action !== undefined) {
      holder.setAttribute(`${prefix}action`, change.action);
    }
    if (change.target !== undefined) {
      holder.setAttribute(`${prefix}target`, change.target);
    }
  };
  document.addEventListener("click", onClick, true);
  document.addEventListener("submit", onSubmit, true);
  return () => {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("submit", onSubmit, true);
  };
}
