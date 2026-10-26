import { SkeletonList } from "@/components/Skeleton";

/**
 * Only on routes that never answer not-found: a loading boundary streams the page, so a `notFound()` below one is
 * sent with status 200.
 */
export default function Loading() {
  return <SkeletonList rows={8} />;
}
