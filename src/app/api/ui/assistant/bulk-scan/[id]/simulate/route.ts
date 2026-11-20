import type { NextRequest } from "next/server";
import { errorResponse, json, readJson } from "@/agent-api/http";
import { loadSpec } from "@/bulk-scan/load";
import { simulate, versionOf } from "@/bulk-scan/spec";
import { prisma } from "@/store/prisma";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { uiRefusals, uiViewer } from "../../../../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Runs one envelope through a saved version of the spec: a generated scenario by name, or the key/value pairs sent. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (!virtualAgentsEnabled()) {
    return errorResponse(404, "the Bulk Scan form builder is not available on this deployment");
  }
  return await uiRefusals("bulk scan simulation", async () => {
    const { id } = await context.params;
    const body = (await readJson(request)) as { version?: unknown; scenario?: unknown; data?: unknown };
    const { spec } = await loadSpec(prisma, { actorOid: viewer.oid, ownerOid: viewer.oid }, id, versionOf(body.version));
    const { data, expected, caseData } = simulate(spec, body);
    return json({ data, expected, case_data: caseData });
  });
}
