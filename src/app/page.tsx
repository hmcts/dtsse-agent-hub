import { redirect } from "next/navigation";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { defaultUi } from "@/web/home";

export const dynamic = "force-dynamic";

/**
 * The front door. The CFT Workspace is the default UI, so `/` sends people to `/assistant`; the hub keeps its own
 * pages under `/hub`. Decided here rather than in `next.config.mjs`'s `redirects()`, because that is baked at build
 * time and the Assistant answers 404 while virtual agents are off, which would make `/` a 404 on those deployments.
 */
export default async function RootPage() {
  redirect(defaultUi(virtualAgentsEnabled()));
}
