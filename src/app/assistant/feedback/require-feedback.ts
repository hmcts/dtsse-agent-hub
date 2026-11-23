import { notFound } from "next/navigation";
import { feedbackEnabled } from "@/feedback/settings";

/** Not found while prototype feedback is off, so its pages say nothing about a feature that is not there. */
export function requireFeedback(): void {
  if (!feedbackEnabled()) {
    notFound();
  }
}
