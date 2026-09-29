import { notFound } from "next/navigation";
import { Suspense } from "react";
import { postToTopics } from "@/app/_actions/posts";
import type { ChannelSummary } from "@/channels/store";
import { ChannelHeader } from "@/components/feed/ChannelHeader";
import { ChannelView } from "@/components/feed/ChannelView";
import { SkeletonFeed } from "@/components/Skeleton";
import { requireViewer } from "@/viewer/current";
import { channel, feedPage } from "@/web/data";
import { DeleteChannel } from "./DeleteChannel";

export const dynamic = "force-dynamic";

async function Feed({ found }: { found: ChannelSummary }) {
  return <ChannelView topics={found.topics} match={found.match} initial={await feedPage(found.topics, found.match)} post={postToTopics} />;
}

/** The channel is looked up before its feed streams in, so one the viewer may not see is still sent as a 404. */
export default async function SavedChannel({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const found = await channel(viewer, id);
  if (found === undefined) {
    notFound();
  }
  const mine = found.owner.oid === viewer.oid;
  return (
    <>
      <ChannelHeader
        kind={mine ? (found.shared ? "Your channel, shared" : "Your channel") : `Shared by ${found.owner.name}`}
        title={found.name}
        topics={found.topics}
        match={found.match}
        saveable={!mine}
      >
        {mine ? <DeleteChannel id={found.id} /> : null}
      </ChannelHeader>
      <Suspense key={found.id} fallback={<SkeletonFeed rows={8} />}>
        <Feed found={found} />
      </Suspense>
    </>
  );
}
