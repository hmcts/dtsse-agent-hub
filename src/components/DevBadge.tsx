import { DEV_TENANT } from "@/agent-auth/dev";

/** Marks a development identity wherever an owner is named, so its agents are never read as a real person's. */
export function DevBadge({ tid }: { tid: string }) {
  if (tid !== DEV_TENANT) {
    return null;
  }
  return (
    <span
      className="ml-1 rounded border border-amber-700 px-1 text-[10px] font-semibold uppercase tracking-wide text-amber-300"
      title="A development identity: sign-in was disabled"
    >
      dev
    </span>
  );
}
