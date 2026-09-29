import { notFound } from "next/navigation";
import { Suspense } from "react";
import { postToTopics } from "@/app/_actions/posts";
import { ChannelHeader } from "@/components/feed/ChannelHeader";
import { ChannelView } from "@/components/feed/ChannelView";
import { SkeletonFeed } from "@/components/Skeleton";
import { normaliseSlug } from "@/topics/slug";
import { requireViewer } from "@/viewer/current";
import { feedPage } from "@/web/data";

export const dynamic = "force-dynamic";

async function Feed({ slug }: { slug: string }) {
  return <ChannelView topics={[slug]} match="any" initial={await feedPage([slug], "any")} post={postToTopics} />;
}

/** The slug is checked before the feed streams in, so a malformed one is still sent as a 404. */
export default async function TopicPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireViewer();
  const { slug: raw } = await params;
  let slug: string;
  try {
    slug = normaliseSlug(decodeURIComponent(raw));
  } catch {
    notFound();
  }
  return (
    <>
      <ChannelHeader kind="Topic" title={`#${slug}`} topics={[slug]} match="any" saveable />
      <Suspense key={slug} fallback={<SkeletonFeed rows={8} />}>
        <Feed slug={slug} />
      </Suspense>
    </>
  );
}
