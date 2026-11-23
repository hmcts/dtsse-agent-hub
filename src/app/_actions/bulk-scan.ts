"use server";

import { revalidatePath } from "next/cache";
import { deleteSpec, signOffVersion } from "@/bulk-scan/spec-store";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { type ActionResult, runAction, text } from "@/web/action";

/**
 * Sign-off and deletion of the signed-in person's own Bulk Scan form specs. Each re-reads the viewer and hands that one
 * oid to the store as actor and owner, so a spec another person owns reads as missing.
 */

const OFF = { ok: false, error: "the CFT Workspace is not available on this deployment" } as const;

function revalidate(): void {
  revalidatePath("/assistant/bulk-scan", "layout");
}

/** Marks a version signed off by the person now. */
export async function signOffSpec(form: FormData): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("sign off spec", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const version = Number(text(form.get("version")));
    if (!Number.isInteger(version) || version < 1) {
      return { ok: false, error: "choose a version to sign off" };
    }
    await signOffVersion(prisma, { actorOid: viewer.oid, ownerOid: viewer.oid }, text(form.get("id")), version);
    revalidate();
    return { ok: true, confirmation: `Version ${version} is signed off` };
  });
}

/** Deletes one of the person's own specs with all its versions. The list reads again on the `bulk_scan_spec` event it sends. */
export async function deleteBulkScanSpec(form: FormData): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("delete spec", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    if (!(await deleteSpec(prisma, { actorOid: viewer.oid, ownerOid: viewer.oid }, text(form.get("id"))))) {
      return { ok: false, error: "that is not one of your form specs" };
    }
    return { ok: true, confirmation: "The form spec is deleted" };
  });
}
