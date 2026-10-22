import { describe, expect, it } from "vitest";
import { THEME_COOKIE, themeCookie, themeOf } from "./theme.ts";

describe("themeOf", () => {
  it.each([
    ["light", "light"],
    ["dark", "dark"],
    ["system", "system"],
    [undefined, "system"],
    ["sepia", "system"]
  ] as const)("should read %j as %s when it is the stored choice", (value, theme) => {
    expect(themeOf(value)).toBe(theme);
  });
});

describe("themeCookie", () => {
  it("should keep the choice for a year across the whole site when it is written", () => {
    expect(themeCookie("light")).toBe(`${THEME_COOKIE}=light; Path=/; Max-Age=31536000; SameSite=Lax`);
  });
});
