"use client";

import "./globals.css";
import type { ErrorInfo } from "next/error";
import { ErrorPanel } from "@/components/ErrorPanel";

/** Replaces the root layout when it throws, as it does when the sidebar's reads cannot reach Postgres. */
export default function GlobalError({ error, retry }: ErrorInfo) {
  return (
    <html lang="en" className="dark h-full">
      <body className="h-full overflow-hidden bg-hub-pane text-[15px] text-hub-text antialiased">
        <title>Something went wrong · Agent Hub</title>
        <main className="flex h-full min-w-0 flex-col">
          <ErrorPanel error={error} retry={retry} />
        </main>
      </body>
    </html>
  );
}
