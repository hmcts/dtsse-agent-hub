import Link from "next/link";
import type { Identity } from "@/users/identity";

/** The bar every page sits under. With sign-in disabled it says so, and names the development identity in use. */
export function Header({ viewer, signInDisabled }: { viewer: Identity | undefined; signInDisabled: boolean }) {
  return (
    <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-900">
      {signInDisabled ? (
        <p role="note" className="border-b border-amber-800 bg-amber-950 px-6 py-1.5 text-center text-xs text-amber-200">
          Sign-in is disabled on this deployment. You are acting as <strong>{viewer?.name ?? "nobody"}</strong>, a development identity shared by everyone using
          it.
        </p>
      ) : null}
      <div className="flex h-14 items-center gap-6 px-6">
        <Link href="/" className="shrink-0 font-semibold text-indigo-300">
          Agent Hub
        </Link>
        <nav aria-label="Main" className="flex items-center gap-1">
          <HeaderLink href="/" label="Overview" />
          <HeaderLink href="/topics" label="Topics" />
          <HeaderLink href="/channels/new" label="New channel" />
          <HeaderLink href="/access" label="Access" />
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm text-slate-300">
          {viewer ? <span>{viewer.name}</span> : null}
          {signInDisabled ? null : (
            <a href="/auth/logout" className="text-slate-400 hover:text-slate-100">
              Sign out
            </a>
          )}
        </div>
      </div>
    </header>
  );
}

function HeaderLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="rounded px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-slate-800 hover:text-slate-100">
      {label}
    </Link>
  );
}
