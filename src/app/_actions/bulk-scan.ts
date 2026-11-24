"use server";

import { revalidatePath } from "next/cache";
import { deleteSpec, pinSpec, renameSpec, signOffVersion } from "@/bulk-scan/spec-store";
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

/** Deletes one of the person's own specs with all its versions. */
export async function deleteBulkScanSpec(form: FormData): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("delete spec", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    if (!(await deleteSpec(prisma, { actorOid: viewer.oid, ownerOid: viewer.oid }, text(form.get("id"))))) {
      return { ok: false, error: "that is not one of your form specs" };
    }
    revalidate();
    return { ok: true, confirmation: "The form spec is deleted" };
  });
}

/** Renames one of the person's own form specs, from its row in the sidebar. */
export async function renameBulkScanSpec(input: { formId: unknown; name: unknown }): Promise<ActionResult> {
  return await runAction("rename spec", async (): Promise<ActionResult> => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    await renameSpec(prisma, { actorOid: viewer.oid, ownerOid: viewer.oid }, text(input.formId), input.name);
    revalidate();
    return { ok: true };
  });
}

/** Pins one of the person's own form specs above the date groups, or unpins it. */
export async function pinBulkScanSpec(input: { formId: unknown; pinned: unknown }): Promise<ActionResult> {
  return await runAction("pin spec", async (): Promise<ActionResult> => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    await pinSpec(prisma, { actorOid: viewer.oid, ownerOid: viewer.oid }, text(input.formId), input.pinned);
    revalidate();
    return { ok: true };
  });
}

/** Deletes one of the person's own form specs, from its row in the sidebar. */
export async function removeBulkScanSpec(input: { formId: unknown }): Promise<ActionResult> {
  return await runAction("delete spec", async (): Promise<ActionResult> => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    if (!(await deleteSpec(prisma, { actorOid: viewer.oid, ownerOid: viewer.oid }, text(input.formId)))) {
      return { ok: false, error: "that is not one of your form specs" };
    }
    revalidate();
    return { ok: true };
  });
}
