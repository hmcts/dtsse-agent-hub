import { canSeeAssistantMemory } from "../access/rules.ts";
import { clientSupports } from "../agents/client-features.ts";
import type { PrismaClient } from "../store/prisma.ts";
import { DEFAULT_SIZE, isVirtualAgentSize, sizeChangeRefusal, sizeChangeRollsPod, type VirtualAgentSize } from "../virtual-agents/size.ts";
import { type MemoryReport, type MemoryUse, memoryUse } from "./memory-report.ts";

/**
 * The memory of a person's assistant's pod: what the pod reported, and the two other facts the Size section needs to
 * say anything useful about it — the size it is running at, and how many chats have a session on it now.
 *
 * **The hub cannot see a pod's memory**: every call between the two is pod to hub, so the pod reports and this is the
 * only account there is. Nothing here infers it. It could not honestly: the hub knows how many sessions it asked for,
 * not what they cost on the day.
 */

/** What the settings' Size section is given beside its own report. */
export interface AssistantMemory {
  use: MemoryUse;
  size: VirtualAgentSize;
  /** Chats whose session the pod says is starting or live, which a change of size would end. */
  openChats: number;
  /** A change of size would replace a pod that is already up, so the section says what that ends. */
  rollsPod: boolean;
  /** Why the size cannot be changed at all, or `undefined` when it can; `sizeChangeRefusal`'s answer. */
  refusal: string | undefined;
}

/**
 * Replaces the virtual agent's memory report.
 *
 * It **notifies nobody**, for the reasons a disk report does not: the figures are read by the owner's own settings,
 * which the action they took revalidates, and the pod that reported is the pod that already knows. A NOTIFY every ten
 * minutes per pod would be traffic for a page nobody is watching change.
 */
export async function reportMemoryUse(prisma: PrismaClient, virtualAgentId: string, report: MemoryReport, now: Date = new Date()): Promise<void> {
  await prisma.virtualAgent.updateMany({
    where: { id: virtualAgentId },
    data: {
      memoryLimitBytes: BigInt(report.limit_bytes),
      memoryCurrentBytes: BigInt(report.current_bytes),
      memoryPeakBytes: BigInt(report.peak_bytes),
      memoryAnonBytes: BigInt(report.anon_bytes),
      memoryReportedAt: now,
      updatedAt: now
    }
  });
}

/**
 * What the viewer's assistant reports about its memory, or `undefined` when it is not theirs.
 *
 * `reports` comes from the pod's *own* session — the virtual agent's current agent, which is the supervisor's
 * registration — because the supervisor is what reads the cgroup, not a conversation's session.
 *
 * A session the supervisor reports `queued` is not counted among the open chats: it is waiting for a slot, so it is
 * costing the pod nothing and closing it would free nothing.
 */
export async function assistantMemory(prisma: PrismaClient, viewerOid: string, virtualAgentId: string): Promise<AssistantMemory | undefined> {
  const agent = await prisma.virtualAgent.findUnique({
    where: { id: virtualAgentId },
    select: {
      ownerOid: true,
      desired: true,
      status: true,
      size: true,
      memoryLimitBytes: true,
      memoryCurrentBytes: true,
      memoryPeakBytes: true,
      memoryAnonBytes: true,
      memoryReportedAt: true,
      agent: { select: { clientFeatures: true } }
    }
  });
  if (agent === null || !canSeeAssistantMemory(viewerOid, agent.ownerOid)) {
    return undefined;
  }
  return {
    use: memoryUse({
      memoryLimitBytes: agent.memoryLimitBytes,
      memoryCurrentBytes: agent.memoryCurrentBytes,
      memoryPeakBytes: agent.memoryPeakBytes,
      memoryAnonBytes: agent.memoryAnonBytes,
      memoryReportedAt: agent.memoryReportedAt,
      running: agent.status === "running",
      reports: clientSupports(agent.agent?.clientFeatures, "memory-anon")
    }),
    size: isVirtualAgentSize(agent.size) ? agent.size : DEFAULT_SIZE,
    openChats: await prisma.assistantConversation.count({
      where: { virtualAgentId, ownerOid: viewerOid, sessionState: { in: ["starting", "live"] } }
    }),
    rollsPod: sizeChangeRollsPod(agent),
    refusal: sizeChangeRefusal(agent)
  };
}
