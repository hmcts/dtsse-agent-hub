"use server";

import { revalidatePath } from "next/cache";
import { sessionSecret } from "@/auth/settings";
import { isCredentialKind } from "@/credentials/names";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { storePastedCode } from "@/virtual-agents/logins";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { createVirtualAgent as create, setDesired } from "@/virtual-agents/store";
import { type ActionResult, runAction, text } from "@/web/action";

/**
 * Creating, starting, stopping and deleting the signed-in person's own virtual agents, and pasting a login code back
 * to one. The owner is always the session's identity; an id from the form names an agent, and `setDesired` and
 * `storePastedCode` refuse one that is not the viewer's.
 */

const LIST_PATH = "/virtual";

const OFF: { ok: false; error: string } = { ok: false, error: "virtual agents are not available on this deployment" };

function revalidate(id?: string): void {
  revalidatePath(LIST_PATH);
  if (id !== undefined) {
    revalidatePath(`${LIST_PATH}/${id}`);
  }
}

export async function createVirtualAgent(form: FormData): Promise<ActionResult<{ confirmation: string; id: string }>> {
  return await runAction<{ confirmation: string; id: string }>("create virtual agent", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const row = await create(prisma, { owner: viewer, modelRoute: viewer.modelRoute, name: form.get("name") });
    revalidate();
    return { ok: true, id: row.id, confirmation: `${row.name} is starting` };
  });
}

async function desire(name: string, form: FormData, desired: "running" | "stopped" | "deleted"): Promise<ActionResult> {
  return await runAction(name, async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const id = text(form.get("id"));
    if (id === "") {
      return { ok: false, error: "no virtual agent was named" };
    }
    await setDesired(prisma, viewer.oid, id, desired);
    revalidate(id);
    return { ok: true };
  });
}

export async function startVirtualAgent(form: FormData): Promise<ActionResult> {
  return await desire("start virtual agent", form, "running");
}

export async function stopVirtualAgent(form: FormData): Promise<ActionResult> {
  return await desire("stop virtual agent", form, "stopped");
}

export async function deleteVirtualAgent(form: FormData): Promise<ActionResult> {
  return await desire("delete virtual agent", form, "deleted");
}

/** The code a sign-in page gave the owner, sealed for their pod to fetch once. Never echoed back. */
export async function pasteLoginCode(form: FormData): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("paste login code", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const id = text(form.get("id"));
    const kind = text(form.get("kind"));
    if (id === "" || !isCredentialKind(kind)) {
      return { ok: false, error: "no sign-in was named" };
    }
    const secret = sessionSecret();
    if (secret === undefined) {
      return { ok: false, error: "this deployment has no SESSION_SECRET, so a pasted code cannot be kept for the agent" };
    }
    await storePastedCode(prisma, viewer.oid, id, kind, form.get("code"), secret);
    revalidate(id);
    return { ok: true, confirmation: "Sent to your virtual agent" };
  });
}
