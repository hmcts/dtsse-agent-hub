import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { HttpError } from "@/agent-api/http";
import { THEME_COOKIE, themeOf } from "@/assistant/theme";
import { ReviewShell } from "@/components/feedback/ReviewShell";
import { reviewLanding } from "@/feedback/review-api";
import { feedbackEnabled } from "@/feedback/settings";
import { type OpenFeedbackLink, openFeedbackLink } from "@/feedback/store";
import { feedbackTicketUrl } from "@/port-viewer/serve";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/** The link when the viewer may review through it, read once for the metadata and the page together. */
const reviewable = cache(async (token: string): Promise<{ viewer: Awaited<ReturnType<typeof requireViewer>>; opened: OpenFeedbackLink }> => {
  if (!feedbackEnabled()) {
    notFound();
  }
  const viewer = await requireViewer();
  try {
    return { viewer, opened: await openFeedbackLink(prisma, viewer.oid, token) };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      notFound();
    }
    throw error;
  }
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { opened } = await reviewable((await params).token);
  return { title: `Feedback: ${opened.link.project.name} – ${opened.link.label}` };
}

/**
 * A feedback link's review page: the prototype framed from the viewer's host, with the bar and comment panel around
 * it. Behind sign-in like every page; anyone signed in holding a live link may review through it, and a revoked,
 * archived or unknown one is not found. The frame's `src` is a ticket minted here for this person, so the proxied
 * prototype is only ever reached through this page.
 */
export default async function ReviewPage({ params, searchParams }: Props) {
  const { token } = await params;
  const { viewer, opened } = await reviewable(token);
  const { link, access } = opened;
  const frameSrc = await feedbackTicketUrl(viewer, token, reviewLanding(link.targetUrl, (await searchParams).path));
  if (frameSrc === undefined) {
    notFound();
  }
  const theme = themeOf((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <div className="asst-theme flex min-h-0 flex-1 flex-col" data-theme={theme}>
      <ReviewShell
        token={token}
        frameSrc={frameSrc}
        projectName={link.project.name}
        linkLabel={link.label}
        viewerName={viewer.name}
        access={access}
        maskInputs={link.project.maskInputs}
        retentionDays={link.project.retentionDays}
      />
    </div>
  );
}
