import { describe, expect, it } from "vitest";
import { OPEN_SCOPE } from "../../src/config/recipients.js";
import { DEFAULT_BULK_CONFIRM_ABOVE } from "../../src/config/schema.js";
import { calendarAvailability } from "../../src/domains/calendar/availability.js";
import { JmapClient } from "../../src/jmap/client.js";
import type {
  Calendar,
  CalendarEvent,
  CalendarEventQueryArguments,
  PrincipalGetAvailabilityArguments,
} from "../../src/jmap/types/calendars.js";
import type {
  GetResponse,
  Invocation,
  JmapRequest,
  JmapResponse,
} from "../../src/jmap/types/core.js";
import { perInvocationCache, type ToolContext } from "../../src/registry/define-tool.js";
import { fixtureSession, loadFixture } from "../fixtures/client.js";

const calendars = loadFixture<GetResponse<Calendar>>("calendar-get.json");
const availability = loadFixture<{ accountId: string; list: unknown[] }>(
  "principal-availability.json",
);

/**
 * The events the fallback reads, written here rather than pulled from a fixture:
 * each one exists to be kept or dropped for a stated reason, and a fixture would
 * hide which is which.
 */
const FALLBACK_EVENTS: CalendarEvent[] = [
  // Kept, and overlapping: two meetings at the same hour are one busy hour.
  {
    id: "ev-a",
    title: "Titre confidentiel A",
    calendarIds: { "cal-1": true },
    freeBusyStatus: "busy",
    status: "confirmed",
    utcStart: "2026-09-03T12:00:00Z",
    utcEnd: "2026-09-03T13:00:00Z",
  },
  {
    id: "ev-b",
    title: "Titre confidentiel B",
    calendarIds: { "cal-2": true },
    freeBusyStatus: "busy",
    status: "confirmed",
    utcStart: "2026-09-03T12:30:00Z",
    utcEnd: "2026-09-03T14:00:00Z",
  },
  // Dropped: cal-3 sets includeInAvailability to none.
  {
    id: "ev-c",
    title: "Titre confidentiel C",
    calendarIds: { "cal-3": true },
    freeBusyStatus: "busy",
    status: "confirmed",
    utcStart: "2026-09-03T07:00:00Z",
    utcEnd: "2026-09-03T08:00:00Z",
  },
  // Dropped: its owner marked it as not blocking.
  {
    id: "ev-d",
    title: "Titre confidentiel D",
    calendarIds: { "cal-1": true },
    freeBusyStatus: "free",
    status: "confirmed",
    utcStart: "2026-09-03T15:00:00Z",
    utcEnd: "2026-09-03T16:00:00Z",
  },
  // Dropped: a cancelled event occupies nobody.
  {
    id: "ev-e",
    title: "Titre confidentiel E",
    calendarIds: { "cal-1": true },
    freeBusyStatus: "busy",
    status: "cancelled",
    utcStart: "2026-09-03T17:00:00Z",
    utcEnd: "2026-09-03T18:00:00Z",
  },
];

/** What each method answers, keyed by name. A missing key answers nothing useful. */
type Script = Record<string, [string, Record<string, unknown>]>;

const HAPPY: Script = {
  "Calendar/get": ["Calendar/get", calendars as unknown as Record<string, unknown>],
  "Principal/getAvailability": [
    "Principal/getAvailability",
    availability as unknown as Record<string, unknown>,
  ],
  "CalendarEvent/query": [
    "CalendarEvent/query",
    {
      accountId: "acc-1",
      queryState: "q-1",
      position: 0,
      ids: FALLBACK_EVENTS.map((e) => e.id),
      total: 5,
    },
  ],
  "CalendarEvent/get": [
    "CalendarEvent/get",
    { accountId: "acc-1", state: "s-1", list: FALLBACK_EVENTS, notFound: [] },
  ],
};

/**
 * A transport that answers per method name.
 *
 * `fakeTransport` serves a queue, which cannot express the one case this file
 * exists for: a method that answers with an `error` invocation rather than with
 * its own name.
 */
function scripted(script: Script): { context: ToolContext; requests: JmapRequest[] } {
  const requests: JmapRequest[] = [];

  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as JmapRequest;
    requests.push(request);

    const body: JmapResponse = {
      methodResponses: request.methodCalls.map(([name, , callId]): Invocation => {
        const [answered, args] = script[name] ?? [name, {}];
        return [answered, args, callId];
      }),
      sessionState: "session-state-1",
    };

    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

  return {
    context: {
      client: new JmapClient({
        apiUrl: "https://mail.example.com/jmap/",
        bearerToken: "a-token",
        fetchImpl,
      }),
      session: fixtureSession(),
      recipients: OPEN_SCOPE,
      bulkConfirmAbove: DEFAULT_BULK_CONFIRM_ABOVE,
      once: perInvocationCache(),
    },
    requests,
  };
}

const refusing = (type: string): Script => ({
  ...HAPPY,
  "Principal/getAvailability": ["error", { type }],
});

const DAY = { after: "2026-09-03", before: "2026-09-03" };

const availabilityArgumentsOf = (requests: JmapRequest[]) =>
  requests[1]?.methodCalls[0]?.[1] as unknown as PrincipalGetAvailabilityArguments;

describe("calendar_availability, before any request", () => {
  it("refuses a window wider than the bound the server states", async () => {
    const { context, requests } = scripted(HAPPY);

    // session.json advertises maxAvailabilityDuration P90D.
    const { text } = await calendarAvailability.run(
      { after: "2026-01-01", before: "2027-12-31" },
      context,
    );

    expect(text).toContain("at most 90 day(s)");
    expect(requests).toHaveLength(0);
  });

  it("accepts a window that fits inside that bound", async () => {
    const { context, requests } = scripted(HAPPY);

    await calendarAvailability.run({ after: "2026-09-01", before: "2026-09-30" }, context);

    expect(requests.length).toBeGreaterThan(0);
  });

  it("refuses an unknown zone", async () => {
    const { context, requests } = scripted(HAPPY);

    const { text } = await calendarAvailability.run({ ...DAY, timeZone: "CEST" }, context);

    expect(text).toContain("Refused");
    expect(requests).toHaveLength(0);
  });

  it("refuses a date the calendar does not have", async () => {
    const { context, requests } = scripted(HAPPY);

    const { text } = await calendarAvailability.run(
      { after: "2026-02-31", before: "2026-03-01" },
      context,
    );

    expect(text).toContain('Refused: "2026-02-31"');
    expect(requests).toHaveLength(0);
  });

  it("refuses a window whose bounds are the wrong way round", async () => {
    const { context, requests } = scripted(HAPPY);

    const { text } = await calendarAvailability.run(
      { after: "2026-09-30", before: "2026-09-01" },
      context,
    );

    expect(text).toContain("holds no time");
    expect(requests).toHaveLength(0);
  });

  it("requires both bounds, through its own schema", () => {
    expect(calendarAvailability.inputSchema.safeParse({ after: "2026-09-03" }).success).toBe(false);
    expect(calendarAvailability.inputSchema.safeParse({ ...DAY }).success).toBe(true);
    expect(
      calendarAvailability.inputSchema.safeParse({ after: "tuesday", before: "friday" }).success,
    ).toBe(false);
  });
});

describe("calendar_availability, on the server path", () => {
  it("asks about the account's own principal, with no detail at all", async () => {
    const { context, requests } = scripted(HAPPY);

    await calendarAvailability.run(DAY, context);

    expect(requests[1]?.methodCalls.map(([name]) => name)).toEqual(["Principal/getAvailability"]);
    expect(availabilityArgumentsOf(requests)).toEqual({
      accountId: "acc-1",
      id: "principal-1",
      utcStart: "2026-09-02T22:00:00Z",
      utcEnd: "2026-09-03T21:59:59Z",
      showDetails: false,
      eventProperties: null,
    });
  });

  it("says the server answered", async () => {
    const { context } = scripted(HAPPY);

    const { text } = await calendarAvailability.run(DAY, context);

    expect(text).toContain("Answered by the server, through Principal/getAvailability.");
  });

  it("folds the periods that overlap, and keeps the one that does not", async () => {
    const { context } = scripted(HAPPY);

    const { text } = await calendarAvailability.run(DAY, context);

    // 07:00–08:00Z stands alone; 12:00–13:00Z and 12:30–14:00Z are one stretch.
    expect(text).toContain("- 2026-09-03 09:00 → 2026-09-03 10:00");
    expect(text).toContain("- 2026-09-03 14:00 → 2026-09-03 16:00");
    expect(text.match(/^- /gm)).toHaveLength(2);
  });

  it("names the zone the window was read in", async () => {
    const { context } = scripted(HAPPY);

    const { text } = await calendarAvailability.run(DAY, context);

    expect(text).toContain("times in Europe/Paris (from the default calendar Personal)");
  });

  it("says the window is free rather than rendering an empty list", async () => {
    const { context } = scripted({
      ...HAPPY,
      "Principal/getAvailability": ["Principal/getAvailability", { accountId: "acc-1", list: [] }],
    });

    const { text } = await calendarAvailability.run(DAY, context);

    expect(text).toContain("Free: nothing occupies this window.");
  });
});

describe("calendar_availability, on the fallback", () => {
  it("opens only on a forbidden, and lets any other method error travel", async () => {
    const { context, requests } = scripted(refusing("serverFail"));

    await expect(calendarAvailability.run(DAY, context)).rejects.toThrow();
    // Two round trips and no third: the fallback never ran.
    expect(requests).toHaveLength(2);
  });

  it("reads the account's own calendars when the method is forbidden", async () => {
    const { context, requests } = scripted(refusing("forbidden"));

    await calendarAvailability.run(DAY, context);

    expect(requests).toHaveLength(3);
    expect(requests[2]?.methodCalls.map(([name]) => name)).toEqual([
      "CalendarEvent/query",
      "CalendarEvent/get",
    ]);
  });

  it("expands recurrences over the window, both bounds being present", async () => {
    const { context, requests } = scripted(refusing("forbidden"));

    await calendarAvailability.run(DAY, context);

    const query = requests[2]?.methodCalls[0]?.[1] as unknown as CalendarEventQueryArguments;
    expect(query.expandRecurrences).toBe(true);
    expect(query.filter).toEqual({ after: "2026-09-03T00:00:00", before: "2026-09-03T23:59:59" });
    expect(query.timeZone).toBe("Europe/Paris");
  });

  it("asks for no property that could carry event content", async () => {
    const { context, requests } = scripted(refusing("forbidden"));

    await calendarAvailability.run(DAY, context);

    const fetch = requests[2]?.methodCalls[1]?.[1] as Record<string, unknown>;
    const properties = fetch.properties as string[];

    for (const forbidden of ["title", "description", "participants", "locations"]) {
      expect(properties).not.toContain(forbidden);
    }
  });

  it("drops an excluded calendar, a free event and a cancelled one, then folds the rest", async () => {
    const { context } = scripted(refusing("forbidden"));

    const { text } = await calendarAvailability.run(DAY, context);

    // ev-a and ev-b fold into 12:00–14:00Z, which is 14:00–16:00 in Paris.
    expect(text).toContain("- 2026-09-03 14:00 → 2026-09-03 16:00");
    expect(text.match(/^- /gm)).toHaveLength(1);
  });

  it("renders no title, no participant and no description of any event", async () => {
    const { context } = scripted(refusing("forbidden"));

    const { text } = await calendarAvailability.run(DAY, context);

    expect(text).not.toContain("Titre confidentiel");
    for (const event of FALLBACK_EVENTS) {
      expect(text).not.toContain(event.id);
    }
  });

  it("says which path answered, and what that path cannot see", async () => {
    const { context } = scripted(refusing("forbidden"));

    const { text } = await calendarAvailability.run(DAY, context);

    expect(text).toContain("this server refused Principal/getAvailability");
    expect(text).toContain("shared with you by someone else is not counted");
    expect(text).toContain("only the events you attend is counted in full here");
  });

  it("admits it read only part of a window holding more events than it fetches", async () => {
    const { context } = scripted({
      ...refusing("forbidden"),
      "CalendarEvent/query": [
        "CalendarEvent/query",
        { accountId: "acc-1", queryState: "q-1", position: 0, ids: [], total: 900 },
      ],
    });

    const { text } = await calendarAvailability.run(DAY, context);

    expect(text).toContain("Only the first 200 of 900 events");
    expect(text).toContain("narrow the window");
  });
});
