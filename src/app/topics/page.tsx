import Link from "next/link";
import { EmptyState } from "@/components/EmptyState";
import { Section } from "@/components/Section";
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
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-100">Topics</h1>
      <Section
        heading={q === "" ? "All topics" : `Topics starting ${q}`}
        detail="most recently active first"
        action={
          <form action="/topics" method="get" role="search" className="flex gap-2">
            <label htmlFor="topic-search" className="sr-only">
              Search topics
            </label>
            <input id="topic-search" name="q" defaultValue={q} className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100" />
            <button type="submit" className="rounded border border-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-800">
              Search
            </button>
          </form>
        }
      >
        {rows.length === 0 ? (
          <EmptyState message={q === "" ? "Nobody has posted on a topic yet." : `No topic starts with "${q}".`} />
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-400">
              <tr>
                <th scope="col" className="py-1 pr-4 font-medium">
                  Topic
                </th>
                <th scope="col" className="py-1 pr-4 font-medium">
                  Posts
                </th>
                <th scope="col" className="py-1 font-medium">
                  Last post
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.map((topic) => (
                <tr key={topic.slug}>
                  <td className="py-1.5 pr-4">
                    <Link href={`/topics/${topic.slug}`} className="font-mono text-indigo-300 hover:text-indigo-200">
                      #{topic.slug}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-4 text-slate-300">{topic.message_count}</td>
                  <td className="py-1.5 text-slate-300">
                    {topic.last_message_at ? <time dateTime={topic.last_message_at}>{instant(topic.last_message_at)}</time> : "never"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
