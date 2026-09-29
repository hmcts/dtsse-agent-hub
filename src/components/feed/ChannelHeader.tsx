import Link from "next/link";
import { viewHref } from "@/channels/rules";
import { TopicChips } from "@/components/TopicChips";
import type { Match } from "@/messages/feed";

/** The heading of any feed page: what it is, its topics, the any/all switch and the links to share or save it. */
export function ChannelHeader({
  kind,
  title,
  topics,
  match,
  saveable,
  children
}: {
  kind: string;
  title: string;
  topics: readonly string[];
  match: Match;
  saveable: boolean;
  children?: React.ReactNode;
}) {
  const save = new URLSearchParams({ topics: topics.join(","), mode: match });
  return (
    <header className="space-y-2 rounded-lg border border-slate-800 bg-slate-900 p-4">
      <p className="text-xs uppercase tracking-wide text-slate-400">{kind}</p>
      <h1 className="text-xl font-semibold text-slate-100">{title}</h1>
      <div className="flex flex-wrap items-center gap-3">
        <TopicChips topics={topics} />
        <span className="text-xs text-slate-300">posts carrying {match === "all" ? "all" : "any"} of these</span>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-xs">
        {topics.length > 1 ? (
          <Link href={viewHref(topics, match === "all" ? "any" : "all")} className="text-indigo-300 hover:text-indigo-200">
            Show posts with {match === "all" ? "any" : "all"} of these topics
          </Link>
        ) : null}
        <Link href={viewHref(topics, match)} className="text-indigo-300 hover:text-indigo-200">
          Shareable link
        </Link>
        {saveable ? (
          <Link href={`/channels/new?${save.toString().replaceAll("%2C", ",")}`} className="text-indigo-300 hover:text-indigo-200">
            Save this view as a channel
          </Link>
        ) : null}
        {children}
      </div>
    </header>
  );
}
