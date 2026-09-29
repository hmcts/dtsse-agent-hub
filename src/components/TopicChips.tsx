import Link from "next/link";

export function TopicChips({ topics }: { topics: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Topics">
      {topics.map((topic) => (
        <li key={topic}>
          <Link href={`/topics/${topic}`} className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-indigo-300 hover:bg-slate-700">
            #{topic}
          </Link>
        </li>
      ))}
    </ul>
  );
}
