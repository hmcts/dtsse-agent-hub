import { describe, expect, it } from "vitest";
import { checkName, createRefusal, MAX_NAME_LENGTH, MAX_VIRTUAL_AGENTS_PER_USER } from "./limits.ts";

describe("checkName", () => {
  it.each([
    ["pcs-api", "pcs-api"],
    ["  PCS-Api \n", "pcs-api"],
    ["a", "a"],
    ["x".repeat(MAX_NAME_LENGTH), "x".repeat(MAX_NAME_LENGTH)],
    ["agent-2", "agent-2"]
  ])("should accept %j as %s when it is a slug", (raw, name) => {
    expect(checkName(raw)).toEqual({ ok: true, name });
  });

  it.each([
    ["nothing", undefined, "give the virtual agent a name"],
    ["a blank", "   ", "give the virtual agent a name"],
    ["a number", 42, "give the virtual agent a name"],
    ["a name that is too long", "x".repeat(MAX_NAME_LENGTH + 1), "at most 64"],
    ["a leading hyphen", "-pcs", "lowercase letters"],
    ["a trailing hyphen", "pcs-", "lowercase letters"],
    ["a double hyphen", "pcs--api", "lowercase letters"],
    ["a space", "pcs api", "lowercase letters"],
    ["markup", "<b>pcs</b>", "lowercase letters"]
  ])("should refuse %s", (_label, raw, error) => {
    const checked = checkName(raw);

    expect(checked.ok).toBe(false);
    expect(checked.ok ? "" : checked.error).toContain(error);
  });
});

describe("createRefusal", () => {
  it("should allow a create when the person has fewer than the limit", () => {
    expect(createRefusal(MAX_VIRTUAL_AGENTS_PER_USER - 1)).toBeUndefined();
  });

  it("should refuse a create when the person already has the most agents allowed", () => {
    expect(createRefusal(MAX_VIRTUAL_AGENTS_PER_USER)).toBe(`you already have ${MAX_VIRTUAL_AGENTS_PER_USER} virtual agents; delete one first`);
  });
});
