/**
 * The person's choice of the Assistant's appearance, kept in a cookie so the server renders the page in it and it
 * never flashes the other theme first. `system` follows the device's light or dark setting.
 */

export type Theme = "system" | "light" | "dark";

export const THEMES: readonly Theme[] = ["system", "light", "dark"];

export const THEME_COOKIE = "asst_theme";

/** A year: the choice is a preference, not a session. */
export const THEME_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export function themeOf(value: string | undefined): Theme {
  return value === "light" || value === "dark" ? value : "system";
}

/** The cookie that stores `theme`; not `HttpOnly`, since the switch writes it from the browser. */
export function themeCookie(theme: Theme): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${THEME_MAX_AGE_SECONDS}; SameSite=Lax`;
}
