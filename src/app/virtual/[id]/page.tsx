import { redirect } from "next/navigation";

/** A virtual agent's page is `/agents/{id}`, where every agent is shown; this keeps links to the old address working. */
export default async function VirtualAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/agents/${encodeURIComponent(id)}`);
}
