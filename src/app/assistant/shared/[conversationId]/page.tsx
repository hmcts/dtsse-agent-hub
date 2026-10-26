import { notFound } from "next/navigation";
import { SharedChat } from "@/components/assistant/SharedChat";
import { requireViewer } from "@/viewer/current";
import { sharedChat } from "@/web/data";

export const dynamic = "force-dynamic";

/**
 * A chat shared with the viewer, read-only, and the same page its owner opens to see what they shared.
 *
 * Anyone else is not found, whether or not they were sent the link: the link reaches a share, it does not grant one.
 * The page is its own address rather than a mode of `/assistant/{id}`, so the owner's chat is untouched, and it does
 * not render the Assistant's shell: a recipient has no business being given an assistant of their own, and opening
 * the shell would create one.
 */
export default async function SharedChatPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const viewer = await requireViewer();
  const { conversationId } = await params;
  const view = await sharedChat(viewer, conversationId);
  if (view === undefined) {
    notFound();
  }
  return <SharedChat view={view} />;
}
