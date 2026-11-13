/**
 * What the team's feedback pages share and can render on the server: the button and field styles, the share address,
 * the status badge and the date and count wording.
 */

export const PRIMARY =
  "inline-flex items-center rounded-[10px] bg-asst-accent px-3.5 py-2 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover disabled:cursor-not-allowed disabled:opacity-50";
export const SECONDARY =
  "inline-flex items-center rounded-[10px] border border-asst-line px-3.5 py-2 text-[13px] font-medium text-asst-text hover:bg-asst-hover disabled:cursor-not-allowed disabled:opacity-50";
export const DANGER =
  "inline-flex items-center rounded-[10px] border border-asst-error px-3.5 py-2 text-[13px] font-medium text-asst-error hover:bg-asst-hover disabled:cursor-not-allowed disabled:opacity-50";
export const FIELD = "rounded-lg border border-asst-strong bg-asst-field px-2.5 py-1.5 text-[13px] text-asst-text outline-hidden focus:border-asst-accent-line";
export const LINK = "text-asst-accent underline hover:text-asst-accent-hover";

/** Where a reviewer opens a link: the hub's review shell, which frames the prototype. */
export function reviewPath(token: string, pagePath?: string): string {
  return pagePath === undefined ? `/review/${token}` : `/review/${token}?path=${encodeURIComponent(pagePath)}`;
}

const STATUS_STYLE: Record<string, string> = {
  open: "border-asst-accent-line text-asst-accent",
  resolved: "border-asst-line text-asst-muted",
  detached: "border-asst-warn text-asst-warn",
  recording: "border-asst-warn text-asst-warn",
  ready: "border-asst-line text-asst-muted",
  failed: "border-asst-error text-asst-error"
};

export function Badge({ status, children }: Readonly<{ status: string; children?: React.ReactNode }>) {
  return <span className={`inline-flex rounded-full border px-2 py-px text-[11px] font-medium ${STATUS_STYLE[status] ?? ""}`}>{children ?? status}</span>;
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

export function when(iso: string): string {
  return DATE.format(new Date(iso));
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Whether a URL is one the wizard can send for checking: https with a host, as the server will insist, or http too
 * where the server allows it, which `allowPrivateTargets` does on a developer's machine.
 */
export function isTargetUrl(value: string, allowHttp = false): boolean {
  if (!URL.canParse(value.trim())) {
    return false;
  }
  const url = new URL(value.trim());
  return (url.protocol === "https:" || (allowHttp && url.protocol === "http:")) && url.hostname !== "";
}

export const TABS = ["overview", "comments", "recordings", "people", "settings"] as const;
export type ProjectTab = (typeof TABS)[number];

/**
 * The tab `?tab=` names, if the viewer may see it, or the overview. Outside `ProjectPage`, a client module, because the
 * server page calls it.
 */
export function projectTab(value: unknown, owner: boolean): ProjectTab {
  const tab = TABS.find((t) => t === value) ?? "overview";
  return tab === "settings" && !owner ? "overview" : tab;
}
