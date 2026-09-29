import { notFound } from "next/navigation";
import { postToTopics } from "@/app/_actions/posts";
import { ChannelHeader } from "@/components/feed/ChannelHeader";
import { ChannelView } from "@/components/feed/ChannelView";
import { normaliseSlug } from "@/topics/slug";
import { requireViewer } from "@/viewer/current";
import { feedPage } from "@/web/data";

export const dynamic = "force-dynamic";

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
    <div className="space-y-4">
      <ChannelHeader kind="Topic" title={`#${slug}`} topics={[slug]} match="any" saveable />
      <ChannelView key={slug} topics={[slug]} match="any" initial={await feedPage([slug], "any")} post={postToTopics} />
    </div>
  );
}
