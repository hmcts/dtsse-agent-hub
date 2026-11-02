"use server";

import { revalidatePath } from "next/cache";
import { deleteTemplate as remove, saveTemplate as write } from "@/assistant/template-store";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { type ActionResult, runAction, text } from "@/web/action";

/**
 * The signed-in person's own saved prompts. Each action re-reads the viewer and hands that one oid to the store as
 * both the actor and the owner, so an `owner` a form names is never read: the only person whose templates a request
 * can reach is the person making it.
 *
 * Both revalidate `/assistant` as a layout, because the sidebar's settings dialog and both composers are rendered
 * from the same tree and all three offer the list.
 */

function revalidate(): void {
  revalidatePath("/assistant", "layout");
}

/** Adds a template, or replaces the one `id` names when the person is editing an existing one. */
export async function saveTemplate(form: FormData): Promise<ActionResult<{ id: string; confirmation: string }>> {
  return await runAction<{ id: string; confirmation: string }>("save template", async () => {
    const viewer = await requireViewer();
    const id = text(form.get("id"));
    const saved = await write(prisma, {
      actorOid: viewer.oid,
      ownerOid: viewer.oid,
      id: id === "" ? undefined : id,
      name: form.get("name"),
      body: form.get("body")
    });
    revalidate();
    return { ok: true, id: saved.id, confirmation: `"${saved.name}" is saved, and is in the + menu of every chat` };
  });
}

/** Deletes one of the signed-in person's own templates; anyone else's is left alone and reads as missing. */
export async function deleteTemplate(form: FormData): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("delete template", async () => {
    const viewer = await requireViewer();
    if (!(await remove(prisma, { actorOid: viewer.oid, ownerOid: viewer.oid }, text(form.get("id"))))) {
      return { ok: false, error: "that is not one of your templates" };
    }
    revalidate();
    return { ok: true, confirmation: "Your template is deleted" };
  });
}
