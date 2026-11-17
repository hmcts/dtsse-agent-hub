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
    return await renderAndStore(viewer.oid, conversationId, body, request.signal);
  });
}

async function renderAndStore(editorOid: string, conversationId: string, body: z.output<typeof RenderBody>, signal: AbortSignal): Promise<Response> {
  const { name, docxSha256, ...saved } = await writeUserDocmosisData(prisma, {
    conversationId,
    editorOid,
    data: body.data,
    baseVersion: body.base_version,
    baseRevision: body.base_revision
  });
  const docx = await readDocmosisDocx(prisma, conversationId, docxSha256);
  if (docx === null) {
    return errorResponse(404, "the template's .docx is not held");
  }
  const result = await renderTemplate({ docx, data: body.data, name, signal });
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
    const current = await docmosisView(prisma, conversationId);
    if (current !== null && current.version === saved.version && current.revision > saved.revision && current.by === "user") {
      return Response.json({ ...saved, status: "superseded" }, { headers });
    }
    return Response.json({ error: "the template changed while it rendered", current }, { status: 409, headers });
  }
  if (result.ok) {
    return Response.json({ ...saved, status: "rendered" }, { headers });
  }
  return Response.json({ ...saved, status: "failed", error: { short: result.short, long: result.long } }, { headers });
}
