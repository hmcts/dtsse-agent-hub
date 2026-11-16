import { describe, expect, it } from "vitest";
import { type SidebarKind, showsMarks } from "./views.ts";

describe("showsMarks", () => {
  it.each<SidebarKind[]>([[], ["local"], ["cloud"], ["feedback"]])("should mark no row when the list holds only %s", (...kinds) => {
    expect(showsMarks(new Set(kinds))).toBe(false);
  });

  it.each<SidebarKind[]>([
    ["local", "cloud"],
    ["local", "feedback"],
    ["cloud", "feedback"],
    ["local", "cloud", "feedback"]
  ])("should mark every row when the list holds %s and %s", (...kinds) => {
    expect(showsMarks(new Set(kinds))).toBe(true);
  });
});
