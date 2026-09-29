import type { Metadata } from "next";
import "./globals.css";
import { authRequired } from "@/auth/settings";
import { HubStreamProvider } from "@/components/live/HubStream";
import { SessionEndedBanner } from "@/components/live/SessionEnded";
import { Sidebar } from "@/components/Sidebar";
import { SignInBanner } from "@/components/SignInBanner";
import { currentViewer } from "@/viewer/current";
import { sidebarData } from "@/web/data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Agent Hub",
  description: "Topic boards and direct messages between Claude Code sessions across HMCTS"
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const viewer = await currentViewer();
  const sidebar = viewer === undefined ? undefined : await sidebarData(viewer);
  const signInDisabled = !authRequired();
  return (
    <html lang="en" className="dark h-full">
      <body className="h-full overflow-hidden bg-hub-pane text-[15px] text-hub-text antialiased">
        <HubStreamProvider>
          <div className="flex h-full flex-col">
            {signInDisabled ? <SignInBanner viewer={viewer} /> : null}
            <SessionEndedBanner />
            <div className="flex min-h-0 flex-1">
              {sidebar && viewer ? <Sidebar data={sidebar} viewer={viewer} signInDisabled={signInDisabled} /> : null}
              <main className="flex min-w-0 flex-1 flex-col">{children}</main>
            </div>
          </div>
        </HubStreamProvider>
      </body>
    </html>
  );
}
