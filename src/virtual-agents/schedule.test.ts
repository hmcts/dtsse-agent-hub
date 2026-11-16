import { describe, expect, it } from "vitest";
import {
  AUTO_START_UNUSED_DAYS,
  autoStartTimes,
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

const SEVEN_PM = { hour: 19, minute: 0 };

describe("autoStartTimes", () => {
  it("should run every half hour from 07:30 to 18:30 when the evening stop is 19:00", () => {
    const times = autoStartTimes(SEVEN_PM);

    expect(times).toHaveLength(23);
    expect(times.slice(0, 3)).toEqual(["07:30", "08:00", "08:30"]);
    expect(times.at(-1)).toBe("18:30");
  });

  it("should be in order when listed", () => {
    const times = autoStartTimes(SEVEN_PM);

    expect(times).toEqual([...times].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it("should end with the last slot whose whole window is before an earlier evening stop", () => {
    expect(autoStartTimes({ hour: 17, minute: 0 }).at(-1)).toBe("16:30");
    expect(autoStartTimes({ hour: 17, minute: 15 }).at(-1)).toBe("16:30");
  });

  it("should include a slot whose window ends exactly at the evening stop", () => {
    expect(autoStartTimes({ hour: 8, minute: 0 })).toEqual(["07:30"]);
  });

  it("should offer nothing when the evening stop leaves no room", () => {
    expect(autoStartTimes({ hour: 7, minute: 30 })).toEqual([]);
  });

  it("should offer more when the evening stop is later", () => {
    expect(autoStartTimes({ hour: 21, minute: 0 }).at(-1)).toBe("20:30");
  });
});

describe("AUTO_START_UNUSED_DAYS", () => {
  it("should be a fortnight, as long as a stopped agent's disk is kept", () => {
    expect(AUTO_START_UNUSED_DAYS).toBe(14);
  });
});

describe("isAutoStartTime", () => {
  it.each(["07:30", "12:00", "18:30"])("should accept %s when it is a slot", (time) => {
    expect(isAutoStartTime(time, SEVEN_PM)).toBe(true);
  });

  it.each(["07:00", "07:29", "19:00", "18:31", "8:00", "", NO_AUTO_START, null, undefined, 730])("should refuse %s when it is no slot", (time) => {
    expect(isAutoStartTime(time, SEVEN_PM)).toBe(false);
  });

  it("should refuse a slot the evening stop leaves no room for when the stop is earlier", () => {
    expect(isAutoStartTime("18:30", { hour: 18, minute: 0 })).toBe(false);
    expect(isAutoStartTime("17:30", { hour: 18, minute: 0 })).toBe(true);
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
