"use server";

import { revalidatePath } from "next/cache";
import { checkChannel } from "@/channels/rules";
import { deleteChannel, saveChannel } from "@/channels/store";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { type ActionResult, runAction, text } from "@/web/action";

/** Saves a channel owned by the signed-in person, after the same checks the builder makes as they type. */
export async function createChannel(input: { name: unknown; topics: unknown; match: unknown; shared: unknown }): Promise<ActionResult<{ id: string }>> {
  return await runAction<{ id: string }>("save channel", async () => {
    const viewer = await requireViewer();
    const checked = checkChannel(input);
    if (!checked.ok) {
      return { ok: false, error: [checked.errors.name, checked.errors.topics].filter((part) => part !== undefined).join("; ") };
    }
    const id = await saveChannel(prisma, viewer.oid, checked.channel);
    revalidatePath("/", "layout");
    return { ok: true, id };
  });
}

/** Deletes one of the signed-in person's own channels; anyone else's is left alone. */
export async function removeChannel(form: FormData): Promise<ActionResult> {
  return await runAction("delete channel", async () => {
    const viewer = await requireViewer();
    if (!(await deleteChannel(prisma, viewer.oid, text(form.get("id"))))) {
      return { ok: false, error: "that is not one of your channels" };
    }
    revalidatePath("/", "layout");
    return { ok: true };
  });
}
