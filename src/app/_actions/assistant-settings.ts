"use server";

import { requireViewer } from "@/viewer/current";
import { type AssistantAgent, assistantAgent, type SharedChats, sharedChats } from "@/web/data";

/**
 * Reads for sections of the Assistant's settings that are only needed once the dialog is open at them, so no page
 * pays for them on every render: see `useSettingsData`. Each re-reads the viewer, as every action does.
 */

/** The viewer's assistant, or `null` when they have none yet. */
export async function readAssistantAgent(): Promise<AssistantAgent | null> {
  return (await assistantAgent(await requireViewer())) ?? null;
}

/** The four lists of the Sharing section: four queries, which is why no page reads them for a dialog that is shut. */
export async function readSharedChats(): Promise<SharedChats> {
  return await sharedChats(await requireViewer());
}
