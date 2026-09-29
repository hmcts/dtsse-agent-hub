import Link from "next/link";

export function TopicChips({ topics }: { topics: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Topics">
      {topics.map((topic) => (
        <li key={topic}>
          <Link href={`/topics/${topic}`} className="rounded bg-[#1d9bd1]/10 px-1.5 py-0.5 text-xs text-hub-link hover:bg-[#1d9bd1]/20 hover:underline">
            #{topic}
          </Link>
        </li>
      ))}
    </ul>
  );
}
