import Link from "next/link";
import { viewHref } from "@/channels/rules";
import { PANE_ACTION, PaneHeader } from "@/components/Pane";
import { TopicChips } from "@/components/TopicChips";
import type { Match } from "@/messages/feed";

/** The bar over any feed: what it is, its topics and match mode, and the links to switch, share or save it. */
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
  const other = match === "all" ? "any" : "all";
  return (
    <PaneHeader
      title={title}
      kind={kind}
      subtitle={
        <div className="flex flex-wrap items-center gap-2">
          <TopicChips topics={topics} />
          <span>posts carrying {match === "all" ? "all" : "any"} of these</span>
        </div>
      }
      actions={
        <>
          {topics.length > 1 ? (
            <Link href={viewHref(topics, other)} className={PANE_ACTION}>
              Match {other}
            </Link>
          ) : null}
          <Link href={viewHref(topics, match)} className={PANE_ACTION}>
            Shareable link
          </Link>
          {saveable ? (
            <Link href={`/channels/new?${save.toString().replaceAll("%2C", ",")}`} className={PANE_ACTION}>
              Save as channel
            </Link>
          ) : null}
          {children}
        </>
      }
    />
  );
}
