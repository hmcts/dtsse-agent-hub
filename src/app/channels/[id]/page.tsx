import { notFound } from "next/navigation";
import { postToTopics } from "@/app/_actions/posts";
import { ChannelHeader } from "@/components/feed/ChannelHeader";
import { ChannelView } from "@/components/feed/ChannelView";
import { requireViewer } from "@/viewer/current";
import { channel, feedPage } from "@/web/data";
import { DeleteChannel } from "./DeleteChannel";

export const dynamic = "force-dynamic";

export default async function SavedChannel({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const found = await channel(viewer, id);
  if (found === undefined) {
    notFound();
  }
  const mine = found.owner.oid === viewer.oid;
  return (
    <div className="space-y-4">
      <ChannelHeader
        kind={mine ? (found.shared ? "Your channel, shared" : "Your channel") : `Shared by ${found.owner.name}`}
        title={found.name}
        topics={found.topics}
        match={found.match}
        saveable={!mine}
      >
        {mine ? <DeleteChannel id={found.id} /> : null}
      </ChannelHeader>
      <ChannelView key={found.id} topics={found.topics} match={found.match} initial={await feedPage(found.topics, found.match)} post={postToTopics} />
    </div>
  );
}
