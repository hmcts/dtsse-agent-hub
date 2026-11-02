"use server";

import { revalidatePath } from "next/cache";
import { saveExportDefaults as save } from "@/assistant/export-default-store";
import type { ExportDefaults } from "@/assistant/export-defaults";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { type ActionResult, runAction } from "@/web/action";

/**
 * Saves where the signed-in person's documents go by default. The viewer is re-read and is both the actor and the
 * owner, so the only defaults a request can reach are its sender's own. Revalidates `/assistant` as a layout, because
 * the settings dialog and the document panel both read them.
 */
export async function saveExportDefaults(input: { jira: unknown; confluence: unknown }): Promise<ActionResult<{ defaults: ExportDefaults }>> {
  return await runAction<{ defaults: ExportDefaults }>("save export defaults", async () => {
    const viewer = await requireViewer();
    const defaults = await save(prisma, { actorOid: viewer.oid, ownerOid: viewer.oid }, input);
    revalidatePath("/assistant", "layout");
    return { ok: true, defaults };
  });
}
