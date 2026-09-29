import { describe, expect, it } from "vitest";
import { age, duration, fullInstant, instant } from "./format.ts";

const NOW = Date.parse("2026-09-29T14:05:00.000Z");

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe("instant", () => {
  it("should print UK time whatever the machine's zone when given a summer instant", () => {
    expect(instant("2026-09-29T14:05:00.000Z", NOW)).toBe("29 Sept, 15:05");
  });

  it("should print UK time as GMT when given a winter instant", () => {
    expect(instant("2026-01-15T14:05:00.000Z", NOW)).toBe("15 Jan, 14:05");
  });

  it("should print the same wall-clock time twice when the clocks go back", () => {
    expect(instant("2026-10-25T00:30:00.000Z", NOW)).toBe("25 Oct, 01:30");
    expect(instant("2026-10-25T01:30:00.000Z", NOW)).toBe("25 Oct, 01:30");
  });

  it("should add the year when the instant is not in this year", () => {
    expect(instant("2025-09-29T14:05:00.000Z", NOW)).toBe("29 Sept 2025, 15:05");
  });

  it("should decide the year in UK time when it is New Year's Eve in UTC", () => {
    expect(instant("2025-12-31T23:59:00.000Z", Date.parse("2026-01-01T00:01:00.000Z"))).toBe("31 Dec 2025, 23:59");
  });

  it("should print nothing when the value is not a time", () => {
    expect(instant("not a time", NOW)).toBe("");
  });
});

describe("fullInstant", () => {
  it("should name the year and BST when given a summer instant", () => {
    expect(fullInstant("2026-10-25T00:30:00.000Z")).toBe("Sunday, 25 October 2026 at 01:30 BST (UK time)");
  });

  it("should name GMT when given the same wall-clock time after the clocks go back", () => {
    expect(fullInstant("2026-10-25T01:30:00.000Z")).toBe("Sunday, 25 October 2026 at 01:30 GMT (UK time)");
  });

  it("should name BST from the moment the clocks go forward", () => {
    expect(fullInstant("2026-03-29T00:59:00.000Z")).toBe("Sunday, 29 March 2026 at 00:59 GMT (UK time)");
    expect(fullInstant("2026-03-29T01:00:00.000Z")).toBe("Sunday, 29 March 2026 at 02:00 BST (UK time)");
  });

  it("should print nothing when the value is not a time", () => {
    expect(fullInstant("")).toBe("");
  });
});

describe("age", () => {
  it("should say just now when less than a minute has passed", () => {
    expect(age(ago(59_999), NOW)).toBe("just now");
  });

  it("should say just now when the instant is slightly in the future", () => {
    expect(age(ago(-5_000), NOW)).toBe("just now");
  });

  it("should count whole minutes when less than an hour has passed", () => {
    expect(age(ago(60_000), NOW)).toBe("1 min ago");
    expect(age(ago(3 * 60_000 + 59_000), NOW)).toBe("3 min ago");
    expect(age(ago(59 * 60_000), NOW)).toBe("59 min ago");
  });

  it("should count whole hours when less than a day has passed", () => {
    expect(age(ago(2 * 3_600_000 + 59 * 60_000), NOW)).toBe("2 h ago");
    expect(age(ago(23 * 3_600_000), NOW)).toBe("23 h ago");
  });

  it("should say yesterday when more than a day has passed and it was the day before", () => {
    expect(age("2026-09-28T09:00:00.000Z", NOW)).toBe("yesterday");
  });

  it("should count calendar days in UK time across the clocks going back", () => {
    const monday = Date.parse("2026-10-26T12:00:00.000Z");

    expect(age("2026-10-24T23:30:00.000Z", monday)).toBe("yesterday");
    expect(age("2026-10-24T22:30:00.000Z", monday)).toBe("2 days ago");
  });

  it("should count hours past a day when the clocks going back make a 25-hour day", () => {
    expect(age("2026-10-24T23:00:00.000Z", Date.parse("2026-10-25T23:30:00.000Z"))).toBe("24 h ago");
  });

  it("should count days when less than a week has passed", () => {
    expect(age("2026-09-23T09:00:00.000Z", NOW)).toBe("6 days ago");
  });

  it("should print the date when a week or more has passed", () => {
    expect(age("2026-09-22T09:00:00.000Z", NOW)).toBe("22 Sept, 10:00");
    expect(age("2025-09-22T09:00:00.000Z", NOW)).toBe("22 Sept 2025, 10:00");
  });

  it("should print nothing when the value is not a time", () => {
    expect(age("not a time", NOW)).toBe("");
  });
});

describe("duration", () => {
  it.each([
    [24 * 60 * 60, "24 hours"],
    [3600, "1 hour"],
    [90 * 60, "90 minutes"],
    [60, "1 minute"],
    [90, "90 seconds"],
    [1, "1 second"]
  ])("should print %i seconds as %s when given that length", (seconds, expected) => {
    expect(duration(seconds)).toBe(expected);
  });
});
