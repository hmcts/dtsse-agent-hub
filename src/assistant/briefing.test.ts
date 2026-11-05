import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRIEFING_SKILL, briefingRequest, ukDate, ukDay } from "./briefing.ts";
import { DEFAULT_PRODUCT } from "./products.ts";

describe("ukDate", () => {
  it("should give the UK date when UTC is still on the day before during British Summer Time", () => {
    expect(ukDate(new Date("2026-06-30T23:30:00Z"))).toBe("2026-07-01");
  });

  it("should give the same date as UTC when the UK is on GMT", () => {
    expect(ukDate(new Date("2026-11-05T23:30:00Z"))).toBe("2026-11-05");
  });
});

describe("ukDay", () => {
  it("should name the weekday, day and month without a comma", () => {
    expect(ukDay(new Date("2026-11-05T09:00:00Z"))).toBe("Thursday 5 November");
  });
});

describe("briefingRequest", () => {
  it("should start a chat on the default product whose first message invokes the briefing skill for the UK date", () => {
    expect(briefingRequest(new Date("2026-11-05T07:45:00Z"))).toEqual({
      product: DEFAULT_PRODUCT,
      title: "Morning briefing, Thursday 5 November",
      body: `/${BRIEFING_SKILL} 2026-11-05`
    });
  });

  it("should name a skill the bundled m365 plugin carries", () => {
    const [plugin, skill] = BRIEFING_SKILL.split(":");
    const file = new URL(`../../packages/agent-hub/plugins/${plugin}/skills/${skill}/SKILL.md`, import.meta.url);
    expect(readFileSync(file, "utf8").startsWith(`---\nname: ${skill}\n`)).toBe(true);
  });
});
