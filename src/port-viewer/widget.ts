import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WIDGET_PATH } from "./paths.ts";

/**
 * The feedback widget: the `<script>` put into every page a feedback link serves, and the bundle it loads, which
 * `yarn build:widget` writes to `public/feedback/widget.js`.
 */

/** Every character that could end an attribute value or start markup, as HTML's own escaping of attributes. */
export function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export interface WidgetOptions {
  /** The origin the widget posts to and accepts messages from: the hub's, whose review page frames it. */
  hubOrigin: string;
  /** `/f/<token>`, which the widget keeps the frame's navigation under. */
  prefix: string;
  /** The prototype's own origin, whose absolute links the widget brings back under `prefix`. */
  upstreamOrigin: string;
  maskInputs: boolean;
  prototypeVersion: string | null;
  /** The nonce the page's policy is given for the script, for a policy with `'strict-dynamic'`. */
  nonce: string;
}

/** The script tag for a feedback page. Root-relative, so it loads from the viewer's host, the page's own origin. */
export function widgetSnippet(options: WidgetOptions): string {
  const attributes: [string, string][] = [
    ["src", WIDGET_PATH],
    ["nonce", options.nonce],
    ["data-hub-origin", options.hubOrigin],
    ["data-prefix", options.prefix],
    ["data-upstream-origin", options.upstreamOrigin],
    ["data-mask-inputs", String(options.maskInputs)],
    ["data-version", options.prototypeVersion ?? ""]
  ];
  return `<script ${attributes.map(([name, value]) => `${name}="${escapeAttribute(value)}"`).join(" ")} defer></script>`;
}

export interface WidgetBundle {
  body: Uint8Array<ArrayBuffer>;
  /** A strong `ETag` from the bundle's digest, so a browser revalidating an unchanged bundle is sent no bytes. */
  etag: string;
}

/**
 * The built bundle, or `undefined` before one is built. Read from `public/` under the working directory, which is
 * the app's root under `next dev` and `next start`, and `/app` in the image, where the standalone `server.js` runs
 * beside the `public/` the Dockerfile copies in. Read on each request, so a rebuilt bundle is served at once.
 */
export async function readWidget(root: string = process.cwd()): Promise<WidgetBundle | undefined> {
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = new Uint8Array(await readFile(path.join(root, "public", "feedback", "widget.js")));
  } catch {
    return undefined;
  }
  return { body, etag: `"${createHash("sha256").update(body).digest("base64url")}"` };
}
