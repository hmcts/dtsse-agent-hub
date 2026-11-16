import Link from "next/link";
import { SidebarToggle } from "@/components/assistant/AssistantShell";
import type { FeedbackProjectRow } from "@/web/feedback-data";
import { Badge, LINK, PRIMARY, plural, when } from "./look";

/** The heading row every feedback page has: the sidebar's toggle once it is collapsed, and the page's title. */
export function FeedbackHeader({ title, back, children }: Readonly<{ title: string; back?: { href: string; label: string }; children?: React.ReactNode }>) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <SidebarToggle />
        {back === undefined ? null : (
          <Link href={back.href} className={`${LINK} text-[13px]`}>
            ← {back.label}
          </Link>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 flex-1 text-[22px] font-semibold tracking-tight">{title}</h1>
        {children}
      </div>
    </div>
  );
}

/** The viewer's feedback projects: what each has waiting, and the way to make another. */
export function ProjectList({ projects, archived }: Readonly<{ projects: readonly FeedbackProjectRow[]; archived: boolean }>) {
  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-6 px-5 pb-10 pt-5">
      <FeedbackHeader title="Feedback projects">
        <Link href="/assistant/feedback/new" className={PRIMARY}>
          New feedback project
        </Link>
      </FeedbackHeader>
      <p className="text-pretty text-[13px] text-asst-body">
        Share a prototype with the people testing it. They comment on its pages and record their voice as they go through it, and you read and play it all back
        here.
      </p>
      <div className="text-[13px]">
        <Link href={archived ? "/assistant/feedback" : "/assistant/feedback?archived=1"} className={LINK}>
          {archived ? "Hide archived projects" : "Show archived projects"}
        </Link>
      </div>
      {projects.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-asst-line px-5 py-6">
          <p className="text-[15px]">{archived ? "You have no feedback projects." : "You have no feedback projects yet."}</p>
          <p className="text-[13px] text-asst-muted">Set one up with the prototype's address, and you get a link to send to reviewers.</p>
          <Link href="/assistant/feedback/new" className={PRIMARY}>
            Set up a feedback project
          </Link>
        </div>
      ) : (
        <table className="w-full border-collapse text-left text-[13px]">
          <caption className="sr-only">Your feedback projects</caption>
          <thead>
            <tr className="border-b border-asst-line text-xs text-asst-faint">
              <th scope="col" className="py-2 pr-3 font-medium">
                Project
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Links
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Open comments
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Recordings
              </th>
              <th scope="col" className="py-2 font-medium">
                Last activity
              </th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.id} className="border-b border-asst-line">
                <td className="py-2.5 pr-3">
                  <Link href={`/assistant/feedback/${project.id}`} className={LINK}>
                    {project.name}
                  </Link>
                  <span className="ml-2 text-xs text-asst-faint">{project.access === "owner" ? "yours" : `${project.owner.name}'s`}</span>
                  {project.archivedAt === null ? null : (
                    <span className="ml-2">
                      <Badge status="resolved">archived</Badge>
                    </span>
                  )}
                </td>
                <td className="py-2.5 pr-3">{project.links}</td>
                <td className="py-2.5 pr-3">{project.openThreads}</td>
                <td className="py-2.5 pr-3">{project.recordings}</td>
                <td className="py-2.5">
                  <time dateTime={project.lastActivityAt}>{when(project.lastActivityAt)}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="sr-only">{plural(projects.length, "project")} listed.</p>
    </div>
  );
}
