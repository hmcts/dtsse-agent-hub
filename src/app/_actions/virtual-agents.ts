"use server";

import { revalidatePath } from "next/cache";
import { sessionSecret } from "@/auth/settings";
import { credentialBackend } from "@/credentials/backend";
import { isCredentialKind } from "@/credentials/names";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { isSignInKind, reconnectSignIn as reconnect, SIGN_IN_TITLES, storePastedCode } from "@/virtual-agents/logins";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { sizeChangeRollsPod } from "@/virtual-agents/size";
import { changeVirtualAgentPod, restartVirtualAgent as restart, type VirtualAgentRow } from "@/virtual-agents/store";
import { type ActionResult, runAction, text } from "@/web/action";

/**
 * Restarting the signed-in person's own virtual agents and saving their size and plugins, which the Assistant's
 * settings post to; having one sign in again, which they and the getting-ready screen (`AssistantGate`) post to; and
 * pasting a login code back to one, which only the getting-ready screen does. The owner is always the session's
 * identity; an id from the form names an agent, and `restartVirtualAgent`, `changeVirtualAgentPod`,
 * `storePastedCode` and `reconnectSignIn` refuse one that is not the viewer's.
 */

const OFF: { ok: false; error: string } = { ok: false, error: "virtual agents are not available on this deployment" };

/** Every Assistant page, since each one renders the settings these change. */
function revalidate(): void {
  revalidatePath("/assistant", "layout");
}

/**
 * Replaces a running agent's pod, so it boots again with its owner's credentials and settings read afresh. What each
 * chat was working on at that moment stops; the chats themselves are kept. An agent that is not running is left as
 * it is, since it boots afresh when it next starts anyway.
 */
export async function restartVirtualAgent(form: FormData): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("restart virtual agent", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const id = text(form.get("id"));
    if (id === "") {
      return { ok: false, error: "no virtual agent was named" };
    }
    const row = await restart(prisma, viewer.oid, id, "restarting because you asked it to");
    revalidate();
    return {
      ok: true,
      confirmation: row.desired === "running" ? "Restarting. Your chats are kept." : "It is not running, so it starts afresh next time anyway."
    };
  });
}

/**
 * The size and the plugins of the person's own virtual agent, which the Assistant's settings save together: both are
 * in the pod template, and `changeVirtualAgentPod` writes them in one transaction, so a change of both replaces a
 * running pod once. A form carries `size` only when the size is to change, and `pluginsChosen` only when the plugins
 * are, since a form with no box ticked sends no `plugins` field at all and means the agent loads none.
 *
 * It does not trust an owner from the form: the viewer is re-read and `changeVirtualAgentPod` refuses an agent that is
 * not theirs. The confirmation says what the change did, because a running pod is replaced by it and the sessions on
 * it end.
 */
export async function saveVirtualAgentPod(form: FormData): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("save virtual agent pod", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const id = text(form.get("id"));
    if (id === "") {
      return { ok: false, error: "no virtual agent was named" };
    }
    const sent = { size: form.has("size"), plugins: form.has("pluginsChosen") };
    const change = { ...(sent.size ? { size: form.get("size") } : {}), ...(sent.plugins ? { plugins: form.getAll("plugins") } : {}) };
    const { row, resized, replugged } = await changeVirtualAgentPod(prisma, viewer.oid, id, change);
    revalidate();
    return { ok: true, confirmation: podConfirmation(row, sent, resized, replugged) };
  });
}

/**
 * What the save did, worded as the size's and the plugins' own saves always were when only one of them changes. A
 * size change says whether the pod restarts by `sizeChangeRollsPod`; a plugins change alone by whether it is meant to
 * be running, which is what its own save has always said.
 */
function podConfirmation(row: VirtualAgentRow, sent: { size: boolean; plugins: boolean }, resized: boolean, replugged: boolean): string {
  if (!resized && !replugged) {
    const what = [sent.size ? "size" : null, sent.plugins ? "plugins" : null].filter((part) => part !== null);
    return what.length === 0 ? "Nothing has changed" : `Its ${what.join(" and ")} ${what.length === 1 && sent.size ? "is" : "are"} unchanged`;
  }
  if (!resized) {
    return row.desired === "running" ? `${row.name} is restarting with its new plugins` : `${row.name} loads its new plugins when it next starts`;
  }
  const plugins = replugged ? " with its new plugins" : "";
  return sizeChangeRollsPod(row)
    ? `Restarting at ${row.size}${plugins}. Your chats are kept, and anything one of them was working on has stopped.`
    : `It starts at ${row.size}${plugins} the next time it runs.`;
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
    revalidate();
    return { ok: true, confirmation: "Sent to your virtual agent" };
  });
}

/**
 * Signs the owner in to GitHub, Azure, Atlassian or Claude again: their stored credential goes, and the agent, if running,
 * restarts so its pod relays a fresh sign-in. The credential is the owner's, so their other virtual agents lose it
 * too. A form sending `keep=stored` restarts without deleting anything (see `reconnectSignIn` in logins).
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
    const row = await reconnect(prisma, backend.store, viewer.oid, id, kind, { keepStored: form.get("keep") === "stored" });
    revalidate();
    const title = SIGN_IN_TITLES[kind];
    return {
      ok: true,
      confirmation:
        row.desired === "running" ? `${row.name} is restarting to sign in to ${title} again` : `${row.name} signs in to ${title} when it next starts`
    };
  });
}
