import { authRequired } from "@/auth/settings";
import { Sidebar } from "@/components/Sidebar";
import { SidebarDrawerProvider } from "@/components/sidebar/Drawer";
import { currentViewer } from "@/viewer/current";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { sidebarData } from "@/web/data";

export const dynamic = "force-dynamic";

/** The hub's own pages, with its sidebar. The HMCTS Assistant has a layout of its own under `/assistant`. */
export default async function HubLayout({ children }: { children: React.ReactNode }) {
  const viewer = await currentViewer();
  const sidebar = viewer === undefined ? undefined : await sidebarData(viewer);
  return (
    <SidebarDrawerProvider hasSidebar={sidebar !== undefined}>
      <div className="flex min-h-0 flex-1">
        {sidebar && viewer ? <Sidebar data={sidebar} viewer={viewer} signInDisabled={!authRequired()} virtualAgents={virtualAgentsEnabled()} /> : null}
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
    </SidebarDrawerProvider>
  );
}
