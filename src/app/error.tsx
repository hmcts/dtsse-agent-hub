"use client";

import type { ErrorInfo } from "next/error";
import { ErrorPanel } from "@/components/ErrorPanel";

/** Renders inside the root layout, so the sidebar stays and only the pane is replaced. */
export default function RouteError({ error, retry }: ErrorInfo) {
  return <ErrorPanel error={error} retry={retry} />;
}
