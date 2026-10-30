import { HttpError, json } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { readBytes } from "@/assistant/upload-body";
import { isXlsx, MAX_WELSH_FILE_BYTES, welshFileName } from "@/assistant/welsh";
import { putJobFile } from "@/assistant/welsh-store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A spreadsheet one of the owner's pending Welsh jobs made, kept for them to download. Sent before the job's answer. */
export const PUT = virtualRoute<{ virtualAgentId: string; jobId: string }>(async ({ virtualAgent, request, params }) => {
  const name = welshFileName(request.headers.get("x-file-name"));
  if (name === null) {
    throw new HttpError(400, "X-File-Name must name an .xlsx file");
  }
  const bytes = await readBytes(request, MAX_WELSH_FILE_BYTES);
  if (!isXlsx(bytes)) {
    throw new HttpError(400, "that is not an .xlsx file");
  }
  return json({ file_id: await putJobFile(prisma, virtualAgent, params.jobId, name, bytes) }, 201);
});
