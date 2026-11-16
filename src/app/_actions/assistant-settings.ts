"use server";

import { saveAssistantSchedule } from "@/assistant/schedule-store";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { type ActionResult, runAction, text } from "@/web/action";
import {
  type AssistantAgent,
  assistantAgent,
  type GitIdentitySettings,
  gitIdentitySettings,
  type ScheduleSettings,
  type SharedChats,
  scheduleSettings,
  sharedChats
} from "@/web/data";

/**
 * Reads for sections of the Assistant's settings that are only needed once the dialog is open at them, so no page
 * pays for them on every render: see `useSettingsData`. Each re-reads the viewer, as every action does.
 */

/** The viewer's assistant, or `null` when they have none yet. */
export async function readAssistantAgent(): Promise<AssistantAgent | null> {
  return (await assistantAgent(await requireViewer())) ?? null;
}

export async function readGitIdentity(): Promise<GitIdentitySettings> {
  return await gitIdentitySettings(await requireViewer());
}

/** The four lists of the Sharing section: four queries, which is why no page reads them for a dialog that is shut. */
export async function readSharedChats(): Promise<SharedChats> {
  return await sharedChats(await requireViewer());
}

export async function readSchedule(): Promise<ScheduleSettings> {
  return await scheduleSettings(await requireViewer());
}

/**
 * The signed-in person's auto start time and idle shutdown, from the settings dialog. The viewer is re-read and is the
 * only person a request can reach. Nothing is sent to a pod: the sweep reads both on its next minute.
 */
export async function saveSchedule(form: FormData): Promise<ActionResult<{ confirmation: string }>> {
  return await runAction<{ confirmation: string }>("save assistant schedule", async () => {
    if (!virtualAgentsEnabled()) {
      return { ok: false, error: "the CFT Workspace is not available on this deployment" };
    }
    const viewer = await requireViewer();
    await saveAssistantSchedule(prisma, viewer.oid, { autoStart: text(form.get("autoStart")), idleAfter: text(form.get("idleAfter")) });
    return { ok: true, confirmation: "Your schedule is saved" };
  });
}
