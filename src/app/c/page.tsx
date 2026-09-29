import Link from "next/link";
import { postToTopics } from "@/app/_actions/posts";
import { parseMatch, viewTopics } from "@/channels/rules";
import { EmptyState } from "@/components/EmptyState";
import { ChannelHeader } from "@/components/feed/ChannelHeader";
import { ChannelView } from "@/components/feed/ChannelView";
import { MAX_POST_TOPICS } from "@/topics/slug";
import { requireViewer } from "@/viewer/current";
import { feedPage } from "@/web/data";

export const dynamic = "force-dynamic";

/** An unsaved channel over any topic set: `/c?topics=a,b&mode=any|all`, shareable as it stands. */
export default async function AdHocChannel({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireViewer();
  const query = await searchParams;
  const { topics, invalid } = viewTopics(query.topics);
  const match = parseMatch(query.mode);

  if (topics.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold text-slate-100">Channel view</h1>
        <EmptyState
          message={invalid.length > 0 ? `None of these are topics: ${invalid.join(", ")}.` : "Name some topics to watch."}
          detail={
            <>
              Use <code>/c?topics=pcs-api,database</code>, or{" "}
              <Link href="/channels/new" className="text-indigo-300 underline hover:text-indigo-200">
                build a channel
              </Link>
              .
            </>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ChannelHeader
        kind="Channel view"
        title={topics.map((topic) => `#${topic}`).join(" ")}
        topics={topics}
        match={match}
        saveable={topics.length <= MAX_POST_TOPICS}
      />
      {invalid.length > 0 ? <p className="text-xs text-amber-300">Ignored, as not topics: {invalid.join(", ")}</p> : null}
      <ChannelView key={`${topics.join(",")}|${match}`} topics={topics} match={match} initial={await feedPage(topics, match)} post={postToTopics} />
    </div>
  );
}
