import type { NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, parse, readJson } from "@/agent-api/http";
import { renderTemplate } from "@/assistant/doc-render";
import { docmosisView, readDocmosisDocx, storeDocmosisRender, writeUserDocmosisData } from "@/assistant/docmosis-store";
import { prisma } from "@/store/prisma";
import { docmosisAccess } from "@/web/data";
import { uiRefusals, uiViewer } from "../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RenderBody = z.object({
  data: z.record(z.string(), z.unknown()),
  base_version: z.number().int().min(0),
  base_revision: z.number().int().min(0)
});

/** The conversations with a render under way: one at a time each, so a person typing cannot queue doc-render up behind themselves. */
const rendering = new Set<string>();

/**
 * Saves the owner's data as their version of the conversation's template, has dtsse-doc-render render it, and keeps the
 * PDF or the merge error with that version. The panel then reads the PDF back from `…/versions/{version}/pdf`.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ conversationId: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  return await uiRefusals("docmosis render", async () => {
    const { conversationId } = await context.params;
    const access = await docmosisAccess(viewer, conversationId);
    if (access === undefined) {
      return errorResponse(404, "that chat has no template you can change");
    }
    if (access !== "owner") {
      return errorResponse(403, "only the owner of a chat can change its template");
    }
    const body = parse(RenderBody, await readJson(request));
    if (rendering.has(conversationId)) {
      return errorResponse(429, "a render is already under way", { version: body.base_version, revision: body.base_revision }, { "retry-after": "2" });
    }
    rendering.add(conversationId);
    try {
      return await renderAndStore(viewer.oid, conversationId, body);
    } finally {
      rendering.delete(conversationId);
    }
  });
}

async function renderAndStore(editorOid: string, conversationId: string, body: z.output<typeof RenderBody>): Promise<Response> {
  const saved = await writeUserDocmosisData(prisma, {
    conversationId,
    editorOid,
    data: body.data,
    baseVersion: body.base_version,
    baseRevision: body.base_revision
  });
  const view = await docmosisView(prisma, conversationId, saved.version);
  const docx = view === null ? null : await readDocmosisDocx(prisma, conversationId, view.docx.replace(/^sha256:/, ""));
  if (view === null || docx === null) {
    return errorResponse(404, "the template's .docx is not held");
  }
  const result = await renderTemplate({ docx, data: body.data, name: view.name });
  const headers = { "cache-control": "no-store" };
  if (!result.ok && result.kind === "busy") {
    return Response.json(
      { error: "the renderer is busy", retry_after: result.retryAfter, ...saved },
      { status: 503, headers: { ...headers, "retry-after": String(result.retryAfter) } }
    );
  }
  if (!result.ok && result.kind === "unreachable") {
    return Response.json({ error: `the renderer could not be reached: ${result.message}`, ...saved }, { status: 502, headers });
  }
  const stored = await storeDocmosisRender(prisma, {
    conversationId,
    ...saved,
    ...(result.ok ? { pdf: result.pdf } : { error: { short: result.short, long: result.long } })
  });
  if (!stored) {
    return Response.json({ error: "the template changed while it rendered", current: await docmosisView(prisma, conversationId) }, { status: 409, headers });
  }
  if (result.ok) {
    return Response.json({ ...saved, status: "rendered" }, { headers });
  }
  return Response.json({ ...saved, status: "failed", error: { short: result.short, long: result.long } }, { headers });
}
