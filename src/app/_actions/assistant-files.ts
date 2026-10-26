"use server";

import { revalidatePath } from "next/cache";
import { findAssistant } from "@/assistant/store";
import { type RemoveOutcome, reportedUploadIds, requestUploadRemoval } from "@/assistant/upload-disk";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { type ActionResult, runAction, text } from "@/web/action";

/**
 * Deleting the copies the signed-in person's assistant holds on its own volume. Each action re-reads the viewer and
 * hands that one oid to the store, so the only assistant a request can reach is the person's own.
 *
 * Neither action claims the file is gone. A deletion is a request the pod reads off its sessions stream and carries
 * out, and the hub learns it happened from the pod's next report — so what is confirmed here is that the request was
 * made, and the words say when it takes effect.
 */

/** The half of this that is not a request: the hub's own bytes are gone, so the thread's download is too. */
const HUB_COPY = "The chat still shows a file was attached, but you can no longer download it back from there.";

const UNSUPPORTED = "Your assistant is running an older version that cannot delete its files yet. It can the next time it starts.";

function revalidate(): void {
  revalidatePath("/assistant", "layout");
}

/**
 * What to tell the person, in the words the pod's state earns. Nothing here says the file *is* gone: the pod is what
 * deletes its own copy, so the confirmation promises when rather than claiming it has already happened.
 */
function confirmation(outcome: RemoveOutcome, subject: string, running: boolean): ActionResult<{ confirmation: string }> {
  if (outcome === "unsupported_client") {
    return { ok: false, error: UNSUPPORTED };
  }
  if (outcome === "no_such_upload") {
    return { ok: false, error: "that is not one of your assistant's files" };
  }
  return {
    ok: true,
    confirmation: running
      ? `Your assistant deletes ${subject} within 10 minutes, the next time it checks. ${HUB_COPY}`
      : `Your assistant is stopped, so it deletes ${subject} the next time it starts. ${HUB_COPY}`
  };
}

export async function deleteAssistantFile(form: FormData): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("delete an assistant file", async () => {
    const viewer = await requireViewer();
    const assistant = await findAssistant(prisma, viewer.oid);
    if (assistant === undefined) {
      return { ok: false, error: "you have no assistant" };
    }
    const outcome = await requestUploadRemoval(prisma, viewer.oid, assistant.id, [text(form.get("id"))]);
    revalidate();
    return confirmation(outcome, "that file", assistant.status === "running");
  });
}

/**
 * Every file the pod's last report named. That report is the list, rather than every upload row the person has ever
 * made: a row says a file was fetched once, and asking the pod to delete files it told us it does not have would
 * leave requests outstanding for ever, since nothing would ever confirm them.
 */
export async function deleteAllAssistantFiles(_form: FormData): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("delete every assistant file", async () => {
    const viewer = await requireViewer();
    const assistant = await findAssistant(prisma, viewer.oid);
    if (assistant === undefined) {
      return { ok: false, error: "you have no assistant" };
    }
    const ids = await reportedUploadIds(prisma, viewer.oid, assistant.id);
    if (ids.length === 0) {
      return { ok: false, error: "your assistant has not reported any files to delete" };
    }
    const outcome = await requestUploadRemoval(prisma, viewer.oid, assistant.id, ids);
    revalidate();
    return confirmation(outcome, `all ${ids.length.toLocaleString("en-GB")} of its files`, assistant.status === "running");
  });
}
