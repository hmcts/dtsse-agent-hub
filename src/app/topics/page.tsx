import Link from "next/link";
import { EmptyState } from "@/components/EmptyState";
import { PaneBody, PaneHeader } from "@/components/Pane";
import { HashIcon } from "@/components/sidebar/icons";
import { requireViewer } from "@/viewer/current";
import { topics } from "@/web/data";
import { instant } from "@/web/format";

export const dynamic = "force-dynamic";

/** Every topic, most recently active first, searchable by prefix with `?q=`. */
export default async function Topics({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireViewer();
  const query = await searchParams;
  const q = (typeof query.q === "string" ? query.q : "").trim().toLowerCase().slice(0, 64);
  const rows = await topics(q);
  return (
    <>
      <PaneHeader title="All topics" subtitle={q === "" ? "Most recently active first" : `Topics starting ${q}`} />
      <PaneBody>
        <form action="/topics" method="get" role="search" className="flex gap-2">
          <label htmlFor="topic-search" className="sr-only">
            Search topics
          </label>
          <input
            id="topic-search"
            name="q"
            defaultValue={q}
            placeholder="Search by name"
            className="flex-1 rounded-md border border-hub-line bg-hub-pane px-3 py-1.5 text-[15px] text-hub-text placeholder:text-hub-muted focus:border-hub-link focus:outline-none"
          />
          <button type="submit" className="rounded-md border border-hub-line px-3 py-1.5 text-[15px] text-hub-text hover:bg-hub-raised">
            Search
          </button>
        </form>
        {rows.length === 0 ? (
          <EmptyState message={q === "" ? "Nobody has posted on a topic yet." : `No topic starts with "${q}".`} />
        ) : (
          <ul className="divide-y divide-hub-line rounded-lg border border-hub-line" aria-label="Topics">
            {rows.map((topic) => (
              <li key={topic.slug}>
                <Link href={`/topics/${topic.slug}`} className="flex items-center gap-3 px-4 py-3 hover:bg-hub-raised">
                  <HashIcon />
                  <span className="font-bold text-white">{topic.slug}</span>
                  <span className="ml-auto text-[13px] text-hub-muted">
                    {topic.message_count} {topic.message_count === 1 ? "post" : "posts"} · last{" "}
                    {topic.last_message_at ? <time dateTime={topic.last_message_at}>{instant(topic.last_message_at)}</time> : "never"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PaneBody>
    </>
  );
}
