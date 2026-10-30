import { ICONS } from "../icons.ts";

/**
 * The installed app's icons, which `manifest.ts` and the iOS home-screen link point at. Served from bytes embedded in
 * the bundle (see scripts/pwa-icons.mjs); a file name that is not one of them is a 404, so the parameter is never
 * used to build a path.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await params;
  const encoded = Object.hasOwn(ICONS, file) ? ICONS[file] : undefined;
  if (encoded === undefined) {
    return new Response(null, { status: 404 });
  }
  return new Response(Buffer.from(encoded, "base64"), {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" }
  });
}
