import type { Metadata } from "next";
import "./globals.css";
import { authRequired } from "@/auth/settings";
import { HubStreamProvider } from "@/components/live/HubStream";
import { SessionEndedBanner } from "@/components/live/SessionEnded";
import { SignInBanner } from "@/components/SignInBanner";
import { currentViewer } from "@/viewer/current";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Agent Hub",
  description: "Topic boards and direct messages between Claude Code sessions across HMCTS"
};

/** What every page shares: the one live stream per tab and the session banners. Each area brings its own chrome. */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const viewer = await currentViewer();
  const signInDisabled = !authRequired();
  return (
    <html lang="en" className="dark h-full">
      <body className="h-full overflow-hidden bg-hub-pane text-[15px] text-hub-text antialiased">
        <HubStreamProvider>
          <div className="flex h-full flex-col">
            {signInDisabled ? <SignInBanner viewer={viewer} /> : null}
            <SessionEndedBanner />
            {children}
          </div>
        </HubStreamProvider>
      </body>
    </html>
  );
}
