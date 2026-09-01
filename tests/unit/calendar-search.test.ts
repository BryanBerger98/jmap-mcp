import { describe, expect, it } from "vitest";
import { calendarSearch } from "../../src/domains/calendar/search.js";
import type {
  Calendar,
  CalendarEvent,
  CalendarEventQueryArguments,
} from "../../src/jmap/types/calendars.js";
import type { GetResponse, QueryResponse } from "../../src/jmap/types/core.js";
import { decodeCursor, encodeCursor, fingerprint } from "../../src/shared/pagination.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const calendars = loadFixture<GetResponse<Calendar>>("calendar-get.json");
const query = loadFixture<QueryResponse>("calendar-event-query.json");
const rows = loadFixture<GetResponse<CalendarEvent>>("calendar-event-rows.json");

/**
 * The three responses a full search consumes, in call order: the calendars
 * travel alone in the first round trip, the query and the fetch in the second.
 */
const answers = (over: Partial<QueryResponse> = {}) => [calendars, { ...query, ...over }, rows];

/** A one-page answer: the whole result set fits, so no cursor is due. */
const lastPage = () => [
  calendars,
  { ...query, ids: ["ev-01", "ev-02"], total: 2 },
  { ...rows, list: rows.list.slice(0, 2) },
];

const queryArgumentsOf = (requests: { methodCalls: [string, unknown, string][] }[]) =>
  requests[1]?.methodCalls[0]?.[1] as CalendarEventQueryArguments;

describe("calendar_search", () => {
  it("spends two round trips, the first on the calendars alone", async () => {
    const { context, requests } = fakeTransport(answers());

    await calendarSearch.run({}, context);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.methodCalls.map(([name]) => name)).toEqual(["Calendar/get"]);
    // The zone of the query is derived from the first answer, and a
    // back-reference copies a path, never a computed value.
    expect(requests[1]?.methodCalls.map(([name]) => name)).toEqual([
      "CalendarEvent/query",
      "CalendarEvent/get",
    ]);
  });

  it("passes the ids of the query to the fetch by back-reference", async () => {
    const { context, requests } = fakeTransport(answers());

    await calendarSearch.run({}, context);

    const fetch = requests[1]?.methodCalls[1]?.[1] as Record<string, unknown>;
    expect(fetch["#ids"]).toEqual({
      resultOf: "0",
      name: "CalendarEvent/query",
      path: "/ids",
    });
  });

  it("maps each criterion onto its draft condition", async () => {
    const { context, requests } = fakeTransport(answers());

    await calendarSearch.run(
      {
        text: "sprint",
        title: "revue",
        description: "blocages",
        location: "Bleue",
        attendee: "camille@example.org",
        owner: "bryan@example.com",
        uid: "b2c8f0e4-0001@example.com",
        calendarId: "cal-2",
      },
      context,
    );

    expect(queryArgumentsOf(requests).filter).toEqual({
      text: "sprint",
      title: "revue",
      description: "blocages",
      location: "Bleue",
      attendee: "camille@example.org",
      owner: "bryan@example.com",
      uid: "b2c8f0e4-0001@example.com",
      inCalendar: "cal-2",
    });
  });

  it("sends no filter at all when no criterion is given", async () => {
    const { context, requests } = fakeTransport(answers());

    await calendarSearch.run({}, context);

    expect(queryArgumentsOf(requests).filter).toBeUndefined();
  });

  it("sorts by start ascending, the one order both modes accept", async () => {
    const { context, requests } = fakeTransport(answers());

    await calendarSearch.run({}, context);

    expect(queryArgumentsOf(requests).sort).toEqual([{ property: "start", isAscending: true }]);
  });

  it("widens a bare date to the whole day it names", async () => {
    const { context, requests } = fakeTransport(answers());

    await calendarSearch.run({ after: "2026-09-03", before: "2026-09-03" }, context);

    expect(queryArgumentsOf(requests).filter).toEqual({
      after: "2026-09-03T00:00:00",
      before: "2026-09-03T23:59:59",
    });
  });

  it("expands recurrences only when both bounds are given", async () => {
    for (const [input, expected] of [
      [{}, false],
      [{ after: "2026-09-03" }, false],
      [{ before: "2026-09-03" }, false],
      [{ after: "2026-09-01", before: "2026-09-30" }, true],
    ] as const) {
      const { context, requests } = fakeTransport(answers());

      await calendarSearch.run(input, context);

      expect(queryArgumentsOf(requests).expandRecurrences, JSON.stringify(input)).toBe(expected);
    }
  });

  it("warns that a search without a window shows base events, not occurrences", async () => {
    const { context } = fakeTransport(answers());

    const { text } = await calendarSearch.run({}, context);

    expect(text).toContain("no date window");
    expect(text).toContain("Give after and before");
  });

  it("says each line is one occurrence when the window expanded them", async () => {
    const { context } = fakeTransport(answers());

    const { text } = await calendarSearch.run(
      { after: "2026-09-01", before: "2026-09-30" },
      context,
    );

    expect(text).toContain("each line is one occurrence");
  });

  it("names the zone it read the hours in, even when the call gave none", async () => {
    const { context, requests } = fakeTransport(answers());

    const { text } = await calendarSearch.run({}, context);

    expect(text).toContain("Times in Europe/Paris (from the default calendar Personal)");
    expect(queryArgumentsOf(requests).timeZone).toBe("Europe/Paris");
  });

  it("reads the hours in the zone the call asked for", async () => {
    const { context, requests } = fakeTransport(answers());

    const { text } = await calendarSearch.run({ timeZone: "America/New_York" }, context);

    expect(text).toContain("Times in America/New_York (as requested)");
    expect(queryArgumentsOf(requests).timeZone).toBe("America/New_York");
  });

  it("lists every calendar with its id in the header, so no second call discovers them", async () => {
    const { context } = fakeTransport(answers());

    const { text } = await calendarSearch.run({}, context);

    expect(text).toContain("Personal (cal-1, default, Europe/Paris)");
    expect(text).toContain("Holidays (cal-3, hidden)");
  });

  it("refuses an unknown zone before it sends anything", async () => {
    const { context, requests } = fakeTransport(answers());

    const { text } = await calendarSearch.run({ timeZone: "CEST" }, context);

    expect(text).toContain("Refused");
    expect(requests).toHaveLength(0);
  });

  it("refuses a date the calendar does not have, before it sends anything", async () => {
    const { context, requests } = fakeTransport(answers());

    const { text } = await calendarSearch.run({ after: "2026-02-31" }, context);

    expect(text).toContain('Refused: "2026-02-31"');
    expect(requests).toHaveLength(0);
  });

  it("refuses a window whose bounds are the wrong way round", async () => {
    const { context, requests } = fakeTransport(answers());

    const { text } = await calendarSearch.run(
      { after: "2026-09-30", before: "2026-09-01" },
      context,
    );

    expect(text).toContain("holds no time");
    expect(requests).toHaveLength(0);
  });

  it("hands back a cursor when the result set runs past the page", async () => {
    const { context } = fakeTransport(answers());

    const { text, nextCursor } = await calendarSearch.run({}, context);

    expect(nextCursor).toBeDefined();
    expect(text).toContain("57 event(s) match");

    const resumed = decodeCursor(nextCursor as string);
    expect(resumed?.queryState).toBe("event-query-state-1");
    expect(resumed?.position).toBeGreaterThan(0);
  });

  it("hands back no cursor on the last page", async () => {
    const { context } = fakeTransport(lastPage());

    const { nextCursor } = await calendarSearch.run({}, context);

    expect(nextCursor).toBeUndefined();
  });

  it("resumes at the position the cursor carries", async () => {
    const { context, requests } = fakeTransport(answers());
    const cursor = encodeCursor({
      position: 25,
      queryState: "event-query-state-1",
      criteriaFingerprint: fingerprint({
        filter: { title: "revue" },
        timeZone: undefined,
        expandRecurrences: false,
      }),
    });

    await calendarSearch.run({ title: "revue", cursor }, context);

    expect(queryArgumentsOf(requests).position).toBe(25);
  });

  it("refuses a cursor issued for other criteria, before it sends anything", async () => {
    const { context, requests } = fakeTransport(answers());
    const cursor = encodeCursor({
      position: 25,
      queryState: "event-query-state-1",
      criteriaFingerprint: fingerprint({
        filter: { title: "revue" },
        timeZone: undefined,
        expandRecurrences: false,
      }),
    });

    const { text } = await calendarSearch.run({ title: "autre chose", cursor }, context);

    expect(text).toContain("issued for other criteria");
    expect(requests).toHaveLength(0);
  });

  it("refuses a cursor whose zone no longer matches, before it sends anything", async () => {
    const { context, requests } = fakeTransport(answers());
    const cursor = encodeCursor({
      position: 25,
      queryState: "event-query-state-1",
      criteriaFingerprint: fingerprint({
        filter: undefined,
        timeZone: "Europe/Paris",
        expandRecurrences: false,
      }),
    });

    // Sealing the requested zone rather than the resolved one is what lets this
    // refusal happen before the round trip that would resolve it.
    const { text } = await calendarSearch.run({ cursor }, context);

    expect(text).toContain("issued for other criteria");
    expect(requests).toHaveLength(0);
  });

  it("refuses an unreadable cursor", async () => {
    const { context, requests } = fakeTransport(answers());

    const { text } = await calendarSearch.run({ cursor: "not-a-cursor" }, context);

    expect(text).toContain("unreadable");
    expect(requests).toHaveLength(0);
  });

  it("refuses to page on when the calendars moved under the cursor", async () => {
    const { context } = fakeTransport(answers({ queryState: "event-query-state-2" }));
    const cursor = encodeCursor({
      position: 25,
      queryState: "event-query-state-1",
      criteriaFingerprint: fingerprint({
        filter: undefined,
        timeZone: undefined,
        expandRecurrences: false,
      }),
    });

    const { text } = await calendarSearch.run({ cursor }, context);

    expect(text).toContain("skip or repeat");
  });

  it("renders one line per event, in the order the query returned them", async () => {
    const { context } = fakeTransport(lastPage());

    const { text } = await calendarSearch.run({}, context);

    expect(text).toContain("Standup [repeats]");
    expect(text).toContain("Revue de sprint");
    expect(text.indexOf("Standup")).toBeLessThan(text.indexOf("Revue de sprint"));
  });
});
