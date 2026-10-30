import type { Metadata, Viewport } from "next";
import "./globals.css";
import { authRequired } from "@/auth/settings";
import { HubStreamProvider } from "@/components/live/HubStream";
import { SessionEndedBanner } from "@/components/live/SessionEnded";
import { SignInBanner } from "@/components/SignInBanner";
import { ViewportFit } from "@/components/ViewportFit";
import { currentViewer } from "@/viewer/current";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Agent Hub",
  description: "Topic boards and direct messages between Claude Code sessions across HMCTS",
  appleWebApp: { capable: true, title: "CFT Workspace" },
  icons: { apple: { url: "/pwa-icon/180.png", sizes: "180x180", type: "image/png" } }
};

/**
 * `resizes-content`: a phone's keyboard shrinks the layout viewport, as it does a desktop window, instead of only the
 * visible part of it. Without this Chrome on Android leaves the page full height and scrolls it under the keyboard.
 */
export const viewport: Viewport = { width: "device-width", initialScale: 1, interactiveWidget: "resizes-content" };

/** What every page shares: the one live stream per tab and the session banners. Each area brings its own chrome. */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const viewer = await currentViewer();
  const signInDisabled = !authRequired();
  return (
    <html lang="en" className="dark h-full">
      <body className="h-full overflow-hidden bg-hub-pane text-[15px] text-hub-text antialiased">
        <ViewportFit />
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
