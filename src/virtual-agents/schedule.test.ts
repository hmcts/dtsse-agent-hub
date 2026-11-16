import { describe, expect, it } from "vitest";
import {
  AUTO_START_TIMES,
  DEFAULT_IDLE,
  IDLE_CHOICES,
  idleMinutesFor,
  idleOffers,
  idleSelected,
  isAutoStartTime,
  isIdleAfter,
  NO_AUTO_START,
  wallClockOf
} from "./schedule.ts";

describe("AUTO_START_TIMES", () => {
  it("should run every half hour from 07:30 to 18:30 when listed", () => {
    expect(AUTO_START_TIMES).toHaveLength(23);
    expect(AUTO_START_TIMES.slice(0, 3)).toEqual(["07:30", "08:00", "08:30"]);
    expect(AUTO_START_TIMES.at(-1)).toBe("18:30");
  });

  it("should be in order when listed", () => {
    expect([...AUTO_START_TIMES]).toEqual([...AUTO_START_TIMES].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});

describe("isAutoStartTime", () => {
  it.each(["07:30", "12:00", "18:30"])("should accept %s when it is a slot", (time) => {
    expect(isAutoStartTime(time)).toBe(true);
  });

  it.each(["07:00", "07:29", "19:00", "18:31", "8:00", "", NO_AUTO_START, null, undefined, 730])("should refuse %s when it is no slot", (time) => {
    expect(isAutoStartTime(time)).toBe(false);
  });
});

describe("wallClockOf", () => {
  it("should read the hour and minute when given a slot", () => {
    expect(wallClockOf("07:30")).toEqual({ hour: 7, minute: 30 });
  });
});

describe("isIdleAfter", () => {
  it.each(["1h", "2h", "3h", "4h", "never"])("should accept %s when it is offered", (value) => {
    expect(isIdleAfter(value)).toBe(true);
  });

  it.each(["0h", "5h", "120", "Never", DEFAULT_IDLE, "", null, 2])("should refuse %s when it is not offered", (value) => {
    expect(isIdleAfter(value)).toBe(false);
  });
});

describe("idleMinutesFor", () => {
  it("should use the deployment's period when the person has chosen none", () => {
    expect(idleMinutesFor(null, 90)).toBe(90);
  });

  it.each([
    ["1h", 60],
    ["2h", 120],
    ["3h", 180],
    ["4h", 240]
  ])("should use their choice of %s over the deployment's period when they have one", (value, minutes) => {
    expect(idleMinutesFor(value, 120)).toBe(minutes);
  });

  it("should be undefined when they chose never", () => {
    expect(idleMinutesFor("never", 120)).toBeUndefined();
  });

  it("should fall back to the deployment's period when the stored value is none the form offers", () => {
    expect(idleMinutesFor("9h", 120)).toBe(120);
  });
});

describe("idleOffers", () => {
  it("should offer the five choices when the deployment's period is one of them", () => {
    expect(idleOffers(120).map((offer) => offer.label)).toEqual(["1 hour", "2 hours", "3 hours", "4 hours", "Never"]);
  });

  it("should put the deployment's own period first when it is none of them", () => {
    expect(idleOffers(90)[0]).toEqual({ value: DEFAULT_IDLE, label: "90 minutes (default)" });
    expect(idleOffers(90)).toHaveLength(IDLE_CHOICES.length + 1);
  });
});

describe("idleSelected", () => {
  it("should be their choice when they have one", () => {
    expect(idleSelected("4h", 120)).toBe("4h");
  });

  it("should be the choice matching the deployment's period when they have none", () => {
    expect(idleSelected(null, 120)).toBe("2h");
  });

  it("should be the default offer when the deployment's period matches no choice", () => {
    expect(idleSelected(null, 90)).toBe(DEFAULT_IDLE);
  });
});
