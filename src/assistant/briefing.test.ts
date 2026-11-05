import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialKind } from "../credentials/names.ts";
import { BRIEFING_SKILL, briefingRequest, offersBriefing } from "./briefing.ts";
import { DEFAULT_PRODUCT } from "./products.ts";

describe("briefingRequest", () => {
  it("should start a chat on the default product whose first message invokes the briefing skill when given a time", () => {
    expect(briefingRequest(new Date("2026-11-05T07:45:00Z"))).toEqual({
      product: DEFAULT_PRODUCT,
      title: "Morning briefing, Thursday 5 November",
      body: `/${BRIEFING_SKILL} 2026-11-05`
    });
  });

  it("should name the UK's date when UTC is still on the day before", () => {
    expect(briefingRequest(new Date("2026-06-30T23:30:00Z"))).toMatchObject({
      title: "Morning briefing, Wednesday 1 July",
      body: `/${BRIEFING_SKILL} 2026-07-01`
    });
  });

  it("should name a skill the bundled m365 plugin carries when its SKILL.md is read", () => {
    const [plugin, skill] = BRIEFING_SKILL.split(":");
    const file = new URL(`../../packages/agent-hub/plugins/${plugin}/skills/${skill}/SKILL.md`, import.meta.url);
    expect(readFileSync(file, "utf8").startsWith(`---\nname: ${skill}\n`)).toBe(true);
  });
});

describe("offersBriefing", () => {
  const connected = new Set<CredentialKind>(["microsoft"]);
  const briefingSkill = { name: BRIEFING_SKILL, description: "" };

  it("should offer the briefing when Microsoft 365 is connected and the pod reports the skill", () => {
    expect(offersBriefing(connected, [{ name: "m365:mail", description: "" }, briefingSkill])).toBe(true);
  });

  it("should not offer the briefing when the pod does not report the skill", () => {
    expect(offersBriefing(connected, [{ name: "m365:mail", description: "" }])).toBe(false);
  });

  it("should not offer the briefing when no session has reported the pod's skills yet", () => {
    expect(offersBriefing(connected, [])).toBe(false);
  });

  it("should not offer the briefing when Microsoft 365 is not connected", () => {
    expect(offersBriefing(new Set<CredentialKind>(["github"]), [briefingSkill])).toBe(false);
  });
});
