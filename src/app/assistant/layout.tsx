import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { assistantEnabled } from "@/assistant/settings";
import { THEME_COOKIE, themeOf } from "@/assistant/theme";
import { AssistantRefresh } from "@/components/assistant/AssistantRefresh";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "HMCTS Assistant",
  description: "Ask for help with user stories, research, analysis and prototypes"
};

/**
 * The HMCTS Assistant's area: full screen, without the hub's sidebar, in the theme the person chose. Not found while
 * the feature is off.
 */
export default async function AssistantLayout({ children }: { children: React.ReactNode }) {
  if (!assistantEnabled()) {
    notFound();
  }
  const theme = themeOf((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <div className="asst-theme flex min-h-0 flex-1 flex-col" data-theme={theme}>
      <AssistantRefresh />
      {children}
    </div>
  );
}
