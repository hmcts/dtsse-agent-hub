"use client";

import { useState } from "react";
import { THEMES, type Theme, themeCookie } from "@/assistant/theme";

const LABELS: Record<Theme, string> = { system: "Match my device", light: "Light", dark: "Dark" };

function Icon({ theme }: { theme: Theme }) {
  if (theme === "light") {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="h-4 w-4">
        <circle cx="10" cy="10" r="3.5" />
        <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
      </svg>
    );
  }
  if (theme === "dark") {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" className="h-4 w-4">
        <path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8Z" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" className="h-4 w-4">
      <rect x="3" y="4" width="14" height="10" rx="1.5" />
      <path d="M7.5 17h5M10 14v3" />
    </svg>
  );
}

/** Shows `theme` on the page's `.asst-theme` root, without keeping it for the next page. */
export function showTheme(theme: Theme): void {
  document.querySelector<HTMLElement>(".asst-theme")?.setAttribute("data-theme", theme);
}

/** Shows `theme`, and keeps it in a cookie so the next page the server renders is already in it. */
export function keepTheme(theme: Theme): void {
  // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is missing from browsers HMCTS staff still use
  document.cookie = themeCookie(theme);
  showTheme(theme);
}

/** Light, dark or the device's own setting, as three radios; what choosing one does is the caller's. */
export function ThemeChoice({ theme, onChoose }: { theme: Theme; onChoose: (theme: Theme) => void }) {
  return (
    <div role="radiogroup" aria-label="Appearance" className="flex shrink-0 rounded-[9px] bg-asst-hover p-[3px]">
      {THEMES.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={theme === option}
          aria-label={LABELS[option]}
          title={LABELS[option]}
          onClick={() => onChoose(option)}
          className={`flex h-7 w-7 items-center justify-center rounded-[7px] ${theme === option ? "bg-asst-strong text-asst-text" : "text-asst-muted hover:text-asst-text"}`}
        >
          <Icon theme={option} />
        </button>
      ))}
    </div>
  );
}

/** The choice applied and kept at once, where there is no Save to wait for. */
export function ThemeSwitch({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);
  return (
    <ThemeChoice
      theme={theme}
      onChoose={(next) => {
        setTheme(next);
        keepTheme(next);
      }}
    />
  );
}
