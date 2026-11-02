"use client";

import { useRouter } from "next/navigation";
import { useHubEvent } from "@/components/live/HubStream";
import { useSettled } from "@/components/live/useSettled";

/**
 * Re-renders the Assistant's server components when the viewer's assistant, one of their conversations, or the skills
 * the open conversation's session offers changes: the events carry only ids, so the page reads what changed itself.
 * Every one of them is refreshed here rather than where it is shown, so a cold chat coming up — which reports its
 * status, its skills and its conversation from the one transaction — re-reads the page once.
 *
 * The settled refresh waits for the network, because refreshing without one takes the page to the error boundary;
 * see `live/connectivity.ts` and `live/useSettled.ts`.
 */
export function AssistantRefresh() {
  const router = useRouter();
  const refresh = useSettled(() => router.refresh());
  useHubEvent("assistant_conversation", refresh);
  useHubEvent("virtual_agent", refresh);
  // Unfiltered: the stream only carries skills for the agent the tab watches, which is the open conversation's.
  useHubEvent("agent_skills", refresh);
  return null;
}
