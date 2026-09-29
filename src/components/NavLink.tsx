"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** A sidebar row, highlighted as Slack does when it is the page on screen. */
export function NavLink({ href, children, className = "" }: { href: string; children: React.ReactNode; className?: string }) {
  const pathname = usePathname();
  const current = pathname === href;
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={`mx-2 flex h-7 items-center gap-2 rounded-md px-3 text-[15px] ${current ? "bg-hub-active text-white" : "text-hub-muted hover:bg-hub-hover hover:text-hub-text"} ${className}`}
    >
      {children}
    </Link>
  );
}
