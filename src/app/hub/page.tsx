import Link from "next/link";
import { Suspense } from "react";
import { ChannelView } from "@/components/feed/ChannelView";
import { PANE_ACTION, PaneHeader } from "@/components/Pane";
import { SkeletonList } from "@/components/Skeleton";
import type { Identity } from "@/users/identity";
import { requireViewer } from "@/viewer/current";
import { overview } from "@/web/data";

export const dynamic = "force-dynamic";

/**
 * A root `loading.tsx` would wrap every route below it, and turn their not-found 404s into streamed 200s, so the
 * home page streams under its own boundary.
 */
export default async function HomePage() {
  const viewer = await requireViewer();
  return (
    <Suspense fallback={<SkeletonList rows={8} />}>
      <Overview viewer={viewer} />
    </Suspense>
  );
}

async function Overview({ viewer }: { viewer: Identity }) {
  const { topics, watched, activity } = await overview(viewer);

  return (
    <>
      <PaneHeader
        title="Home"
        subtitle={topics.length > 0 ? "Recent activity on the topics of your channels" : "Recent activity on every topic"}
        actions={
          topics.length > 0 ? null : (
            <Link href="/hub/channels/new" className={PANE_ACTION}>
              Build a channel
            </Link>
          )
        }
      />
      <div className="flex min-h-0 flex-1">
        <ChannelView topics={watched} match="any" initial={activity} />
      </div>
    </>
  );
}
