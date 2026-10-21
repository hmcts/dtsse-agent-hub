import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { assistantEnabled } from "@/assistant/settings";
import { AssistantRefresh } from "@/components/assistant/AssistantRefresh";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "HMCTS Assistant",
  description: "Ask for help with user stories, research, analysis and prototypes"
};

/** The HMCTS Assistant's area: full screen, without the hub's sidebar. Not found while the feature is off. */
export default function AssistantLayout({ children }: { children: React.ReactNode }) {
  if (!assistantEnabled()) {
    notFound();
  }
  return (
    <>
      <AssistantRefresh />
      {children}
    </>
  );
}
