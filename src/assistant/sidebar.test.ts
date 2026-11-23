import { describe, expect, it } from "vitest";
import { isChat, sidebarCollapsedOf, sidebarCookie } from "./sidebar.ts";

describe("sidebarCollapsedOf", () => {
  it("should read collapsed only when the cookie says so", () => {
    expect(sidebarCollapsedOf("collapsed")).toBe(true);
    expect(sidebarCollapsedOf(undefined)).toBe(false);
    expect(sidebarCollapsedOf("open")).toBe(false);
  });
});

describe("sidebarCookie", () => {
  it("should keep the choice for a year when the sidebar is collapsed", () => {
    expect(sidebarCookie(true)).toBe("asst_sidebar=collapsed; Path=/; Max-Age=31536000; SameSite=Lax");
  });

  it("should expire the cookie when the sidebar is opened again", () => {
    expect(sidebarCookie(false)).toBe("asst_sidebar=; Path=/; Max-Age=0; SameSite=Lax");
  });
});

describe("isChat", () => {
  it.each([
    ["local", true],
    ["cloud", true],
    ["feedback", false],
    ["form", false]
  ] as const)("should say %s is a chat: %s", (kind, expected) => {
    expect(isChat({ kind })).toBe(expected);
  });
});
