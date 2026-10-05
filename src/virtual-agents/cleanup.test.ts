import { describe, expect, it } from "vitest";
import {
  DISK_WARNING_DAYS,
  diskExpiresAt,
  diskWarningDays,
  dueEveningStop,
  isIdle,
  lastActivity,
  latestEveningStop,
  londonInstant,
  PROVISIONING_TIMEOUT_MS,
  provisioningTimedOut
} from "./cleanup.ts";

const SEVEN_PM = { hour: 19, minute: 0 };

function at(iso: string): Date {
  return new Date(iso);
}

describe("londonInstant", () => {
  it("should be an hour behind UK clocks when the date is in British Summer Time", () => {
    expect(londonInstant(2026, 7, 1, SEVEN_PM).toISOString()).toBe("2026-07-01T18:00:00.000Z");
  });

  it("should match UK clocks when the date is in Greenwich Mean Time", () => {
    expect(londonInstant(2026, 1, 15, SEVEN_PM).toISOString()).toBe("2026-01-15T19:00:00.000Z");
  });

  it.each([
    ["the Friday before the clocks go back", 2026, 10, 23, "2026-10-23T18:00:00.000Z"],
    ["the day the clocks go back", 2026, 10, 25, "2026-10-25T19:00:00.000Z"],
    ["the Monday after the clocks go back", 2026, 10, 26, "2026-10-26T19:00:00.000Z"],
    ["the Friday before the clocks go forward", 2026, 3, 27, "2026-03-27T19:00:00.000Z"],
    ["the day the clocks go forward", 2026, 3, 29, "2026-03-29T18:00:00.000Z"],
    ["the Monday after the clocks go forward", 2026, 3, 30, "2026-03-30T18:00:00.000Z"]
  ])("should give the right instant on %s", (_label, year, month, day, expected) => {
    expect(londonInstant(year, month, day, SEVEN_PM).toISOString()).toBe(expected);
  });

  it("should keep the minutes when the stop time is not on the hour", () => {
    expect(londonInstant(2026, 7, 1, { hour: 18, minute: 45 }).toISOString()).toBe("2026-07-01T17:45:00.000Z");
  });
});

describe("latestEveningStop", () => {
  it.each([
    ["just after a BST Friday's stop", "2026-10-23T18:30:00.000Z", "2026-10-23T18:00:00.000Z"],
    ["just before a BST Friday's stop", "2026-10-23T17:59:59.000Z", "2026-10-22T18:00:00.000Z"],
    ["on the Saturday", "2026-10-24T12:00:00.000Z", "2026-10-23T18:00:00.000Z"],
    ["on the Sunday the clocks go back", "2026-10-25T20:00:00.000Z", "2026-10-23T18:00:00.000Z"],
    ["on the GMT Monday after, at what was the stop time in BST", "2026-10-26T18:30:00.000Z", "2026-10-23T18:00:00.000Z"],
    ["on the GMT Monday after, at its own stop time", "2026-10-26T19:00:00.000Z", "2026-10-26T19:00:00.000Z"],
    ["on the BST Monday after the clocks go forward, at its stop time", "2026-03-30T18:00:00.000Z", "2026-03-30T18:00:00.000Z"],
    ["on the BST Monday after the clocks go forward, an hour before what was the stop time in GMT", "2026-03-30T17:59:00.000Z", "2026-03-27T19:00:00.000Z"],
    ["just after midnight UK time, which is still the previous day in UTC during BST", "2026-07-01T23:30:00.000Z", "2026-07-01T18:00:00.000Z"]
  ])("should find the right stop when it is %s", (_label, now, expected) => {
    expect(latestEveningStop(at(now), SEVEN_PM).toISOString()).toBe(expected);
  });
});

describe("dueEveningStop", () => {
  it("should not stop an agent started that morning when the evening stop has not come", () => {
    expect(dueEveningStop(at("2026-10-26T09:00:00.000Z"), at("2026-10-26T18:59:00.000Z"), SEVEN_PM)).toBe(false);
  });

  it("should stop an agent started that morning when the evening stop has come", () => {
    expect(dueEveningStop(at("2026-10-26T09:00:00.000Z"), at("2026-10-26T19:00:00.000Z"), SEVEN_PM)).toBe(true);
  });

  it("should leave an agent started after the stop when someone is working late", () => {
    expect(dueEveningStop(at("2026-10-26T19:30:00.000Z"), at("2026-10-26T23:00:00.000Z"), SEVEN_PM)).toBe(false);
  });

  it("should stop a late starter when the next weekday's stop comes", () => {
    expect(dueEveningStop(at("2026-10-26T19:30:00.000Z"), at("2026-10-27T19:00:00.000Z"), SEVEN_PM)).toBe(true);
  });

  it("should leave an agent started at the weekend running when it is still the weekend", () => {
    expect(dueEveningStop(at("2026-10-24T10:00:00.000Z"), at("2026-10-25T21:00:00.000Z"), SEVEN_PM)).toBe(false);
  });

  it("should stop an agent started on the BST Friday afternoon when the GMT Monday morning sweep runs", () => {
    expect(dueEveningStop(at("2026-10-23T14:00:00.000Z"), at("2026-10-26T08:00:00.000Z"), SEVEN_PM)).toBe(true);
  });
});

describe("lastActivity", () => {
  it("should pick the latest time when several are given", () => {
    expect(lastActivity(at("2026-10-01T10:00:00Z"), null, at("2026-10-01T12:00:00Z"), undefined)).toEqual(at("2026-10-01T12:00:00Z"));
  });

  it("should be undefined when there are none", () => {
    expect(lastActivity(null, undefined)).toBeUndefined();
  });
});

describe("isIdle", () => {
  const now = at("2026-10-05T12:00:00.000Z");

  it("should be idle when nothing has happened for the idle period and the agent is not busy", () => {
    expect(isIdle("idle", at("2026-10-05T10:00:00.000Z"), now, 120)).toBe(true);
    expect(isIdle(null, at("2026-10-05T10:00:00.000Z"), now, 120)).toBe(true);
  });

  it("should not be idle when something happened within the idle period", () => {
    expect(isIdle("idle", at("2026-10-05T10:00:01.000Z"), now, 120)).toBe(false);
  });

  it("should not be idle when the linked agent is busy, however long ago anything was recorded", () => {
    expect(isIdle("busy", at("2026-10-01T00:00:00.000Z"), now, 120)).toBe(false);
  });
});

describe("provisioningTimedOut", () => {
  const now = at("2026-10-05T12:00:00.000Z");

  it("should time out when the pod has said nothing for the timeout", () => {
    expect(provisioningTimedOut(new Date(now.getTime() - PROVISIONING_TIMEOUT_MS), now)).toBe(true);
  });

  it("should not time out when the pod spoke within it", () => {
    expect(provisioningTimedOut(new Date(now.getTime() - PROVISIONING_TIMEOUT_MS + 1000), now)).toBe(false);
  });
});

describe("disk expiry", () => {
  const stopped = at("2026-10-05T12:00:00.000Z");

  it("should expire the disk the given number of days after the agent stopped", () => {
    expect(diskExpiresAt(stopped, 14).toISOString()).toBe("2026-10-19T12:00:00.000Z");
  });

  it("should not warn when the expiry is further off than the warning period", () => {
    expect(diskWarningDays(at("2026-10-19T12:00:00.000Z"), at("2026-10-16T11:59:00.000Z"))).toBeUndefined();
  });

  it("should warn with the days left when the expiry is within the warning period", () => {
    expect(diskWarningDays(at("2026-10-19T12:00:00.000Z"), at("2026-10-16T12:00:00.000Z"))).toBe(DISK_WARNING_DAYS);
    expect(diskWarningDays(at("2026-10-19T12:00:00.000Z"), at("2026-10-18T13:00:00.000Z"))).toBe(1);
  });

  it("should say no days are left when the expiry has passed", () => {
    expect(diskWarningDays(at("2026-10-19T12:00:00.000Z"), at("2026-10-20T12:00:00.000Z"))).toBe(0);
  });

  it("should not warn when there is no expiry", () => {
    expect(diskWarningDays(null, stopped)).toBeUndefined();
  });
});
