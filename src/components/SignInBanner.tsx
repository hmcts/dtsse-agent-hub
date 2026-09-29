import type { Identity } from "@/users/identity";

/** Says sign-in is off, and names the development identity everyone on the deployment shares. */
export function SignInBanner({ viewer }: { viewer: Identity | undefined }) {
  return (
    <p role="note" className="shrink-0 border-b border-amber-800 bg-amber-950 px-4 py-1 text-center text-xs text-amber-200">
      Sign-in is disabled on this deployment. You are acting as <strong>{viewer?.name ?? "nobody"}</strong>, a development identity shared by everyone using it.
    </p>
  );
}
