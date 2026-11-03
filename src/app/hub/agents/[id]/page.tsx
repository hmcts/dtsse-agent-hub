import { redirect } from "next/navigation";
import { requireViewer } from "@/viewer/current";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { agentAddress } from "@/web/data";
import { NO_AGENT, retiredAgentPath } from "@/web/home";

export const dynamic = "force-dynamic";

/**
 * The hub shows no agents, so an address of one, which people still have in chats and tickets, goes where `retiredAgentPath`
 * says. A page rather than the proxy's redirect, because telling the cases apart reads the database.
 */
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const virtualAgents = virtualAgentsEnabled();
  redirect(retiredAgentPath(virtualAgents ? await agentAddress(viewer, id) : NO_AGENT, virtualAgents));
}
