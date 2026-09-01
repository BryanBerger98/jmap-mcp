import { describe, expect, it } from "vitest";
import {
  describeDuration,
  formatInstant,
  formatRange,
  isValidTimeZone,
  localToUtc,
  normalizeBound,
  parseIsoDuration,
  toUtcDateTime,
} from "../../src/domains/calendar/time.js";

describe("isValidTimeZone", () => {
  it("accepts an IANA name the runtime knows", () => {
    expect(isValidTimeZone("Europe/Paris")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Etc/UTC")).toBe(true);
  });

  it("rejects anything else, including the abbreviations people type", () => {
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("CEST")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("normalizeBound", () => {
  it("opens a bare date at midnight and closes it at the last second", () => {
    expect(normalizeBound("2026-09-03", "start")).toBe("2026-09-03T00:00:00");
    expect(normalizeBound("2026-09-03", "end")).toBe("2026-09-03T23:59:59");
  });

  it("completes the seconds of a bound that stops at the minute", () => {
    expect(normalizeBound("2026-09-03T14:00", "start")).toBe("2026-09-03T14:00:00");
    expect(normalizeBound("2026-09-03T14:00:30", "end")).toBe("2026-09-03T14:00:30");
  });

  it("rejects a date the calendar does not have", () => {
    // The pattern matches it happily; only a real date check catches it.
    expect(normalizeBound("2026-02-31", "start")).toBeUndefined();
    expect(normalizeBound("2026-13-01", "start")).toBeUndefined();
  });

  it("rejects an hour, a minute or a second out of range", () => {
    expect(normalizeBound("2026-09-03T25:00", "start")).toBeUndefined();
    expect(normalizeBound("2026-09-03T12:75", "start")).toBeUndefined();
    expect(normalizeBound("2026-09-03T14:00:75", "start")).toBeUndefined();
  });

  it("rejects what is not a date at all", () => {
    expect(normalizeBound("next tuesday", "start")).toBeUndefined();
    expect(normalizeBound("03/09/2026", "start")).toBeUndefined();
  });
});

describe("localToUtc", () => {
  it("reads a summer hour at the summer offset", () => {
    // Europe/Paris is at +02:00 under daylight saving.
    expect(localToUtc("2026-07-01T12:00:00", "Europe/Paris")).toBe("2026-07-01T10:00:00Z");
  });

  it("reads a winter hour at the winter offset", () => {
    expect(localToUtc("2026-01-15T12:00:00", "Europe/Paris")).toBe("2026-01-15T11:00:00Z");
  });

  it("lands on the right hour on both sides of a daylight-saving change", () => {
    // Paris moves back on 2026-10-25 at 03:00 local. An hour before the change
    // is still +02:00, an hour after it is +01:00, and a single naive pass
    // would give one of the two the offset of the other.
    expect(localToUtc("2026-10-25T00:30:00", "Europe/Paris")).toBe("2026-10-24T22:30:00Z");
    expect(localToUtc("2026-10-25T05:30:00", "Europe/Paris")).toBe("2026-10-25T04:30:00Z");
  });

  it("crosses the date line when the offset is wide enough", () => {
    // +14:00: a local morning is the previous evening in UTC.
    expect(localToUtc("2026-09-03T10:00:00", "Pacific/Kiritimati")).toBe("2026-09-02T20:00:00Z");
  });

  it("returns nothing for a local time it cannot parse", () => {
    expect(localToUtc("not-a-time", "Europe/Paris")).toBeUndefined();
  });
});

describe("toUtcDateTime", () => {
  it("drops the milliseconds the draft does not want", () => {
    expect(toUtcDateTime(Date.parse("2026-09-03T12:00:00.456Z"))).toBe("2026-09-03T12:00:00Z");
  });
});

describe("formatInstant", () => {
  it("renders an instant in the zone it is asked for, not in the runtime's", () => {
    expect(formatInstant("2026-09-03T12:00:00Z", "Europe/Paris")).toBe("2026-09-03 14:00");
    expect(formatInstant("2026-09-03T12:00:00Z", "America/New_York")).toBe("2026-09-03 08:00");
  });

  it("keeps midnight at hour 00, never at hour 24", () => {
    expect(formatInstant("2026-09-02T22:00:00Z", "Europe/Paris")).toBe("2026-09-03 00:00");
  });

  it("drops the hour for an all-day event", () => {
    expect(formatInstant("2026-09-03T12:00:00Z", "Europe/Paris", true)).toBe("2026-09-03");
  });

  it("hands back what it was given when the instant is unreadable", () => {
    expect(formatInstant("soon", "Europe/Paris")).toBe("soon");
  });
});

describe("formatRange", () => {
  it("states the date once when both ends fall on the same day", () => {
    expect(formatRange("2026-09-03T12:00:00Z", "2026-09-03T13:00:00Z", "Europe/Paris")).toBe(
      "2026-09-03 14:00 → 15:00",
    );
  });

  it("states both dates when the span crosses midnight in the answer's zone", () => {
    expect(formatRange("2026-09-03T20:00:00Z", "2026-09-04T06:00:00Z", "Europe/Paris")).toBe(
      "2026-09-03 22:00 → 2026-09-04 08:00",
    );
  });

  it("reads the day boundary in that zone, not in UTC", () => {
    // Two instants on either side of midnight UTC, both on the 4th in Paris:
    // the date is stated once, because in Paris the span never changes day.
    expect(formatRange("2026-09-03T22:00:00Z", "2026-09-04T06:00:00Z", "Europe/Paris")).toBe(
      "2026-09-04 00:00 → 08:00",
    );
  });

  it("renders an all-day span as dates alone", () => {
    expect(formatRange("2026-09-14T00:00:00Z", "2026-09-15T00:00:00Z", "Europe/Paris", true)).toBe(
      "2026-09-14 → 2026-09-15",
    );
  });

  it("says so rather than rendering an empty range", () => {
    expect(formatRange(undefined, "2026-09-03T13:00:00Z", "Europe/Paris")).toBe("(no start)");
  });
});

describe("describeDuration", () => {
  it("counts in the units a reader thinks in", () => {
    expect(describeDuration("2026-09-03T12:00:00Z", "2026-09-03T12:45:00Z")).toBe("45min");
    expect(describeDuration("2026-09-03T12:00:00Z", "2026-09-03T13:30:00Z")).toBe("1h 30min");
    expect(describeDuration("2026-09-03T12:00:00Z", "2026-09-03T14:00:00Z")).toBe("2h");
    expect(describeDuration("2026-09-14T00:00:00Z", "2026-09-16T00:00:00Z")).toBe("2d");
  });

  it("returns nothing rather than a negative span", () => {
    expect(describeDuration("2026-09-03T13:00:00Z", "2026-09-03T12:00:00Z")).toBeUndefined();
    expect(describeDuration(undefined, "2026-09-03T12:00:00Z")).toBeUndefined();
  });
});

describe("parseIsoDuration", () => {
  const day = 24 * 60 * 60 * 1000;

  it("reads the bound the availability capability states", () => {
    expect(parseIsoDuration("P90D")).toBe(90 * day);
    expect(parseIsoDuration("P1Y")).toBe(365 * day);
    expect(parseIsoDuration("P2W")).toBe(14 * day);
    expect(parseIsoDuration("PT1H30M")).toBe(90 * 60 * 1000);
  });

  it("returns nothing for a duration it cannot read, so the caller falls back", () => {
    expect(parseIsoDuration("P")).toBeUndefined();
    expect(parseIsoDuration("90 days")).toBeUndefined();
    expect(parseIsoDuration("")).toBeUndefined();
  });
});
