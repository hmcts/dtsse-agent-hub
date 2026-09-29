import Link from "next/link";
import { EmptyState } from "@/components/EmptyState";

export default function NotFound() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-100">Not found</h1>
      <EmptyState
        message="There is nothing here, or it is not yours to see."
        detail={
          <Link href="/" className="text-indigo-300 underline hover:text-indigo-200">
            Back to the overview
          </Link>
        }
      />
    </div>
  );
}
