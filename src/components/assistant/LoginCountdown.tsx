"use client";

import { useEffect, useState } from "react";
import { Timestamp } from "@/components/time/Timestamp";

/** "m:ss", rounded up so a code never reads as expired while it still works. */
export function remaining(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * How long a login code has left, ticking every second. Before the browser has a clock it shows the expiry time
 * instead, so the server's HTML and the first render agree. The live count is not announced each second; screen
 * readers read it when they reach it.
 */
export function LoginCountdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (now === null) {
    return (
      <span>
        until <Timestamp iso={expiresAt} />
      </span>
    );
  }
  const left = remaining(expiresAt, now);
  return <span>{left === "0:00" ? "expired" : `for ${left}`}</span>;
}
