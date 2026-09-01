import { describe, expect, it } from "vitest";
import {
  calendarNames,
  EVENT_DETAIL_PROPERTIES,
  EVENT_ROW_PROPERTIES,
  eventRow,
  eventTitle,
  intervalsOf,
  mergeIntervals,
  renderCalendars,
  renderEvent,
  renderParticipants,
  resolveTimeZone,
  unknownZoneRefusal,
} from "../../src/domains/calendar/event.js";
import type { Calendar, CalendarEvent } from "../../src/jmap/types/calendars.js";
import type { GetResponse, Id } from "../../src/jmap/types/core.js";
import { loadFixture } from "../fixtures/client.js";

const calendars = loadFixture<GetResponse<Calendar>>("calendar-get.json").list;
const rows = loadFixture<GetResponse<CalendarEvent>>("calendar-event-rows.json").list;
const details = loadFixture<GetResponse<CalendarEvent>>("calendar-event-detail.json").list;

const byId = new Map<Id, Calendar>(calendars.map((calendar) => [calendar.id, calendar]));
const detail = (id: Id): CalendarEvent => details.find((event) => event.id === id) as CalendarEvent;

const PARIS = "Europe/Paris";

describe("property lists", () => {
  it("never asks for recurrenceOverrides, which the draft refuses next to utcStart", () => {
    expect(EVENT_ROW_PROPERTIES).not.toContain("recurrenceOverrides");
    expect(EVENT_DETAIL_PROPERTIES).not.toContain("recurrenceOverrides");
  });

  it("asks for the computed bounds every rendering reads", () => {
    for (const list of [EVENT_ROW_PROPERTIES, EVENT_DETAIL_PROPERTIES]) {
      expect(list).toContain("utcStart");
      expect(list).toContain("utcEnd");
    }
  });
});

describe("unknownZoneRefusal", () => {
  it("says nothing when no zone was asked for", () => {
    expect(unknownZoneRefusal(undefined)).toBeUndefined();
    expect(unknownZoneRefusal(PARIS)).toBeUndefined();
  });

  it("names the bad zone and shows what a good one looks like", () => {
    const refusal = unknownZoneRefusal("CEST") as string;

    expect(refusal).toContain("CEST");
    expect(refusal).toContain("Europe/Paris");
  });
});

describe("resolveTimeZone", () => {
  it("takes the caller's zone, and says it came from them", () => {
    expect(resolveTimeZone("America/New_York", calendars)).toEqual({
      zone: "America/New_York",
      origin: "as requested",
    });
  });

  it("falls to the default calendar and names it", () => {
    expect(resolveTimeZone(undefined, calendars)).toEqual({
      zone: PARIS,
      origin: "from the default calendar Personal",
    });
  });

  it("falls past a default calendar that states no zone", () => {
    const floating: Calendar[] = [
      { id: "cal-1", name: "Personal", isDefault: true, timeZone: null },
      { id: "cal-2", name: "Work", timeZone: "Asia/Tokyo" },
    ];

    expect(resolveTimeZone(undefined, floating)).toEqual({
      zone: "Asia/Tokyo",
      origin: "from the calendar Work",
    });
  });

  it("ends on UTC and says the chain ran out", () => {
    expect(resolveTimeZone(undefined, [])).toEqual({
      zone: "Etc/UTC",
      origin: "by fallback: no calendar states one",
    });
  });
});

describe("renderCalendars", () => {
  it("carries the id of each calendar, which is what a search filter takes", () => {
    const legend = renderCalendars(calendars);

    expect(legend).toContain("Personal (cal-1, default, Europe/Paris)");
    expect(legend).toContain("Work (cal-2, Europe/Paris)");
    expect(legend).toContain("Holidays (cal-3, hidden)");
  });

  it("says none rather than rendering an empty legend", () => {
    expect(renderCalendars([])).toBe("Calendars: (none)");
  });
});

describe("calendarNames", () => {
  it("names the calendars an event sits in", () => {
    expect(calendarNames(rows[0] as CalendarEvent, byId)).toEqual(["Personal"]);
  });

  it("falls back on the raw id rather than inventing a name", () => {
    const orphan: CalendarEvent = { id: "ev-x", calendarIds: { "cal-9": true } };

    expect(calendarNames(orphan, byId)).toEqual(["cal-9"]);
  });
});

describe("eventTitle", () => {
  it("stands in for an event that carries none", () => {
    expect(eventTitle({ id: "ev-x" })).toBe("(untitled)");
    expect(eventTitle({ id: "ev-x", title: "   " })).toBe("(untitled)");
  });
});

describe("eventRow", () => {
  it("renders a row in the answer's zone, with its calendar and its id", () => {
    expect(eventRow(rows[0] as CalendarEvent, PARIS, byId)).toEqual({
      when: "2026-09-01 09:00 → 09:30",
      title: "Standup [repeats]",
      where: "Salle Bleue",
      calendar: "Personal",
      id: "ev-01",
    });
  });

  it("marks a status that is not the ordinary one, and leaves the ordinary one silent", () => {
    const cancelled: CalendarEvent = {
      id: "ev-x",
      title: "Réunion",
      status: "cancelled",
      utcStart: "2026-09-03T12:00:00Z",
      utcEnd: "2026-09-03T13:00:00Z",
    };

    expect(eventRow(cancelled, PARIS, byId).title).toBe("Réunion [cancelled]");
    expect(eventRow({ ...cancelled, status: "confirmed" }, PARIS, byId).title).toBe("Réunion");
  });

  it("renders an event with no title and no place without leaving a hole", () => {
    const bare: CalendarEvent = {
      id: "ev-x",
      utcStart: "2026-09-03T12:00:00Z",
      utcEnd: "2026-09-03T13:00:00Z",
    };

    expect(eventRow(bare, PARIS, byId)).toEqual({
      when: "2026-09-03 14:00 → 15:00",
      title: "(untitled)",
      where: "",
      calendar: "",
      id: "ev-x",
    });
  });
});

describe("renderEvent", () => {
  it("renders the hours, the place, the link and the guest list of a full event", () => {
    const text = renderEvent(detail("ev-01"), PARIS, byId);

    expect(text).toContain("when: 2026-09-03 14:00 → 15:00");
    expect(text).toContain("duration: 1h");
    expect(text).toContain("where: Salle Bleue");
    expect(text).toContain("online: https://meet.example.org/sprint");
    expect(text).toContain("calendars: Work");
    expect(text).toContain("uid: b2c8f0e4-0001@example.com");
  });

  it("says a base event repeats, and never spells the rule out", () => {
    const text = renderEvent(detail("ev-01"), PARIS, byId);

    expect(text).toContain("recurrence: repeats until 2026-12-31");
    expect(text).toContain("search a date window");
    // The rule is data the reader would have to interpret themselves.
    expect(text).not.toContain("weekly");
    expect(text).not.toContain("frequency");
  });

  it("names the base event an occurrence came from", () => {
    const text = renderEvent(detail("ev-01_20260910T140000"), PARIS, byId);

    expect(text).toContain("recurrence: one occurrence of ev-01 (instance 2026-09-10T14:00:00)");
  });

  it("stays quiet about a status, a privacy and a busy state that are the ordinary ones", () => {
    const text = renderEvent(detail("ev-01"), PARIS, byId);

    expect(text).not.toContain("status:");
    expect(text).not.toContain("privacy:");
    expect(text).not.toContain("shows as:");
    expect(text).not.toContain("all day:");
  });

  it("renders an event with no title, no place and no guest as a readable block", () => {
    const text = renderEvent(detail("ev-42"), PARIS, byId);

    expect(text).toContain("title: (untitled)");
    expect(text).toContain("when: 2026-09-14 → 2026-09-15");
    expect(text).toContain("all day: yes");
    expect(text).toContain("status: cancelled");
    expect(text).toContain("shows as: free");
    expect(text).toContain("privacy: private");
    // Dropped, not padded: an empty field is a line that says nothing.
    expect(text).not.toContain("where:");
    expect(text).not.toContain("participants:");
    expect(text).not.toContain("duration:");
  });
});

describe("renderParticipants", () => {
  it("falls back on the address when nobody named the participant", () => {
    const text = renderParticipants(detail("ev-01"));

    expect(text).toContain("camille@example.org (declined)");
    // Never an empty entry standing where a person should be.
    expect(text).not.toContain(";  ");
  });

  it("marks the organiser and the answer each person gave", () => {
    const text = renderParticipants(detail("ev-01"));

    expect(text).toContain("Bryan Berger <bryan@example.com> (organiser, accepted)");
    expect(text).toContain("Ana Silva <ana.silva0@example.org> (needs-action)");
  });

  it("renders nothing at all when the event has no participant", () => {
    expect(renderParticipants(detail("ev-42"))).toBe("");
  });
});

describe("mergeIntervals", () => {
  it("folds two stretches that overlap into one", () => {
    expect(
      mergeIntervals([
        { start: 10, end: 20 },
        { start: 15, end: 30 },
      ]),
    ).toEqual([{ start: 10, end: 30 }]);
  });

  it("folds two stretches that only touch, leaving no free minute to report", () => {
    expect(
      mergeIntervals([
        { start: 10, end: 20 },
        { start: 20, end: 30 },
      ]),
    ).toEqual([{ start: 10, end: 30 }]);
  });

  it("keeps two stretches that leave a gap between them", () => {
    expect(
      mergeIntervals([
        { start: 30, end: 40 },
        { start: 10, end: 20 },
      ]),
    ).toEqual([
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ]);
  });

  it("swallows a stretch entirely inside another", () => {
    expect(
      mergeIntervals([
        { start: 10, end: 40 },
        { start: 15, end: 20 },
      ]),
    ).toEqual([{ start: 10, end: 40 }]);
  });

  it("drops an empty stretch rather than reporting a busy instant", () => {
    expect(mergeIntervals([{ start: 10, end: 10 }])).toEqual([]);
  });

  it("leaves its input alone", () => {
    const input = [
      { start: 10, end: 20 },
      { start: 15, end: 30 },
    ];
    mergeIntervals(input);

    expect(input).toEqual([
      { start: 10, end: 20 },
      { start: 15, end: 30 },
    ]);
  });
});

describe("intervalsOf", () => {
  it("skips an event whose bounds the server did not compute", () => {
    const events: CalendarEvent[] = [
      { id: "a", utcStart: "2026-09-03T12:00:00Z", utcEnd: "2026-09-03T13:00:00Z" },
      { id: "b", utcStart: "2026-09-03T14:00:00Z" },
      { id: "c" },
    ];

    expect(intervalsOf(events)).toEqual([
      { start: Date.parse("2026-09-03T12:00:00Z"), end: Date.parse("2026-09-03T13:00:00Z") },
    ]);
  });
});
