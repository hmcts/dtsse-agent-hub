import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exempt } from "@/auth/guard";
import { HOME_SCREEN_ICON, TAB_ICON } from "./icons";

describe("the CFT Workspace's icons", () => {
  it("should name the crown as the tab icon and keep the home-screen icon, which a segment's icons would replace", async () => {
    const { metadata } = await import("@/app/assistant/layout");

    expect(metadata.icons).toEqual({ icon: TAB_ICON, apple: HOME_SCREEN_ICON });
  });

  it("should point the tab icon at the crown's file, served without a session", () => {
    expect(existsSync(new URL(`../app${TAB_ICON.url}`, import.meta.url))).toBe(true);
    expect(exempt(TAB_ICON.url)).toBe(true);
  });
});
