import type { SidebarKind } from "@/assistant/views";

/** Where a sidebar row, or a search result for one, opens: a chat, a feedback project or a Bulk Scan form's editor. */
export function rowHref(item: { kind: SidebarKind; id: string }): string {
  switch (item.kind) {
    case "feedback":
      return `/assistant/feedback/${item.id}`;
    case "form":
      return `/assistant/bulk-scan/${item.id}`;
    default:
      return `/assistant/${item.id}`;
  }
}
