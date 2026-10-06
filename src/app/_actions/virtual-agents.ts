"use server";

import { revalidatePath } from "next/cache";
import { sessionSecret } from "@/auth/settings";
import { credentialBackend } from "@/credentials/backend";
import { isCredentialKind } from "@/credentials/names";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { isSignInKind, reconnectSignIn as reconnect, storePastedCode } from "@/virtual-agents/logins";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { createVirtualAgent as create, renameVirtualAgent as rename, setDesired, setExposedPort, setVirtualAgentSize } from "@/virtual-agents/store";
import { type ActionResult, runAction, text } from "@/web/action";

/**
 * Creating, starting, stopping, renaming, resizing and deleting the signed-in person's own virtual agents, exposing
 * their web ports, pasting a login code back to one, and having one sign in again. The owner is always the session's
 * identity; an id from the form names an agent, and `setDesired`, `renameVirtualAgent`, `setVirtualAgentSize`,
 * `setExposedPort`, `storePastedCode` and `reconnectSignIn` refuse one that is not the viewer's.
 */

const LIST_PATH = "/virtual";

const PAGE_PATH = "/agents";

const OFF: { ok: false; error: string } = { ok: false, error: "virtual agents are not available on this deployment" };

function revalidate(id?: string): void {
  revalidatePath(LIST_PATH);
  if (id !== undefined) {
    revalidatePath(`${PAGE_PATH}/${id}`);
  }
}

export async function createVirtualAgent(form: FormData): Promise<ActionResult<{ confirmation: string; id: string }>> {
  return await runAction<{ confirmation: string; id: string }>("create virtual agent", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const row = await create(prisma, { owner: viewer, modelRoute: viewer.modelRoute, name: form.get("name"), size: form.get("size") });
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

export async function renameVirtualAgent(form: FormData): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("rename virtual agent", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const id = text(form.get("id"));
    if (id === "") {
      return { ok: false, error: "no virtual agent was named" };
    }
    const row = await rename(prisma, viewer.oid, id, form.get("name"));
    revalidate(id);
    return { ok: true, confirmation: `Renamed to ${row.name}` };
  });
}

export async function resizeVirtualAgent(form: FormData): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("resize virtual agent", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const id = text(form.get("id"));
    if (id === "") {
      return { ok: false, error: "no virtual agent was named" };
    }
    const row = await setVirtualAgentSize(prisma, viewer.oid, id, form.get("size"));
    revalidate(id);
    return { ok: true, confirmation: `${row.name} is now ${row.size}` };
  });
}

async function exposure(name: string, form: FormData, exposed: boolean): Promise<ActionResult> {
  return await runAction(name, async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const id = text(form.get("id"));
    if (id === "") {
      return { ok: false, error: "no virtual agent was named" };
    }
    await setExposedPort(prisma, viewer.oid, id, form.get("port"), exposed);
    revalidate(id);
    return { ok: true };
  });
}

export async function exposePort(form: FormData): Promise<ActionResult> {
  return await exposure("expose port", form, true);
}

export async function unexposePort(form: FormData): Promise<ActionResult> {
  return await exposure("stop exposing port", form, false);
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

/**
 * Signs the owner in to GitHub or Azure again: their stored credential goes, and the agent, if running, restarts so
 * its pod relays a fresh sign-in. The credential is the owner's, so their other virtual agents lose it too.
 */
export async function reconnectSignIn(form: FormData): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("reconnect sign-in", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const id = text(form.get("id"));
    const kind = text(form.get("kind"));
    if (id === "" || !isSignInKind(kind)) {
      return { ok: false, error: "no sign-in was named" };
    }
    const backend = credentialBackend(prisma);
    if (!backend.available) {
      return { ok: false, error: backend.reason };
    }
    const row = await reconnect(prisma, backend.store, viewer.oid, id, kind);
    revalidate(id);
    revalidatePath("/settings/credentials");
    const title = kind === "github" ? "GitHub" : "Azure";
    return {
      ok: true,
      confirmation:
        row.desired === "running" ? `${row.name} is restarting to sign in to ${title} again` : `${row.name} signs in to ${title} when it next starts`
    };
  });
}
