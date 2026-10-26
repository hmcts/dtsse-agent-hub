"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { EmptyState } from "@/components/EmptyState";
import { PaneBody, PaneHeader } from "@/components/Pane";
import { homeFor } from "@/web/home";

/**
 * What an unmatched URL shows. The root `not-found.tsx` is the only boundary Next gives one, whatever the path, and it
 * takes no props — so the way back is read from the path here, on the client, which is what the Next docs prescribe
 * for a not-found page that varies by path.
 */
export function NotFoundPanel() {
  const home = homeFor(usePathname());
  return (
    <>
      <PaneHeader title="Not found" />
      <PaneBody>
        <EmptyState
          message="There is nothing here, or it is not yours to see."
          detail={
            <Link href={home} className="text-hub-link hover:underline">
              Back to home
            </Link>
          }
        />
      </PaneBody>
    </>
  );
}
