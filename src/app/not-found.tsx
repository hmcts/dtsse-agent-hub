import Link from "next/link";
import { EmptyState } from "@/components/EmptyState";
import { PaneBody, PaneHeader } from "@/components/Pane";

export default function NotFound() {
  return (
    <>
      <PaneHeader title="Not found" />
      <PaneBody>
        <EmptyState
          message="There is nothing here, or it is not yours to see."
          detail={
            <Link href="/" className="text-hub-link hover:underline">
              Back to home
            </Link>
          }
        />
      </PaneBody>
    </>
  );
}
