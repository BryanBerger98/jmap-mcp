import { z } from "zod";
import type { JmapClient } from "../../jmap/client.js";
import { JmapMethodError } from "../../jmap/errors.js";
import type { JmapSession } from "../../jmap/session.js";
import type {
  AvailabilityCapability,
  BusyPeriod,
  Calendar,
  CalendarEvent,
  CalendarEventQueryArguments,
  CalendarGetArguments,
  PrincipalGetAvailabilityArguments,
  PrincipalGetAvailabilityResponse,
} from "../../jmap/types/calendars.js";
import type { GetResponse, Id, QueryResponse, ResultReference } from "../../jmap/types/core.js";
import {
  CAPABILITY_CALENDARS,
  CAPABILITY_CORE,
  CAPABILITY_PRINCIPALS_AVAILABILITY,
} from "../../jmap/types/core.js";
import { defineTool } from "../../registry/define-tool.js";
import {
  CALENDAR_PROPERTIES,
  type Interval,
  intervalsOf,
  mergeIntervals,
  resolveTimeZone,
  unknownZoneRefusal,
} from "./event.js";
import {
  BOUND_SCHEMA_PATTERN,
  formatInstant,
  localToUtc,
  normalizeBound,
  parseIsoDuration,
  toUtcDateTime,
} from "./time.js";

/** What the window may span when the server states no bound of its own. */
const DEFAULT_MAX_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/** How many events the fallback reads before it admits the window is too wide. */
const FALLBACK_EVENT_LIMIT = 200;

/** The status of an event that occupies nobody's time. */
const STATUS_CANCELLED = "cancelled";

/** `freeBusyStatus` of an event its owner marked as not blocking. */
const FREE = "free";

const SERVER_SOURCE = "Answered by the server, through Principal/getAvailability.";

const FALLBACK_SOURCE =
  "Answered by reading your own calendars: this server refused Principal/getAvailability, which " +
  "Stalwart disables unless directory queries are turned on.";

/**
 * What the fallback cannot see, stated every time it answers.
 *
 * Both gaps make it report less busy time than the server would, which is the
 * direction that misleads: a window this says is free may not be.
 */
const FALLBACK_LIMITS =
  "It covers the calendars of this account alone, so a calendar shared with you by someone else " +
  "is not counted. A calendar set to count only the events you attend is counted in full here, " +
  "because judging attendance would mean reading the guest list of every event.";

const boundField = z.string().regex(BOUND_SCHEMA_PATTERN, {
  message: "Expected YYYY-MM-DD, or YYYY-MM-DDTHH:MM.",
});

const inputSchema = z.object({
  after: boundField.describe(
    "Start of the window, local date `2026-09-03` or date and time `2026-09-03T09:00`. A bare " +
      "date starts at 00:00.",
  ),
  before: boundField.describe("End of the window, same format. A bare date ends at 23:59."),
  timeZone: z
    .string()
    .optional()
    .describe(
      "IANA zone the bounds are read in and the answer is shown in, e.g. Europe/Paris. Defaults " +
        "to the zone of the default calendar, which the answer always names.",
    ),
});

export const calendarAvailability = defineTool({
  name: "calendar_availability",
  title: "Check calendar availability",
  description:
    "Returns the stretches of a time window during which this account is busy, and nothing else: " +
    "no title, no participant, no description ever appears in the answer. " +
    "Use it to judge a proposed slot before agreeing to it. " +
    "The answer names the time zone the window was read in, and says which of two paths answered " +
    "— the server's own availability method, or a fallback that reads this account's calendars " +
    "when the server keeps that method disabled.",
  inputSchema,
  classes: ["read"],
  classify: () => "read",
  summarize: (input) => `Check availability from ${input.after} to ${input.before}.`,
  run: async (input, { client, session }) => {
    const zoneRefusal = unknownZoneRefusal(input.timeZone);
    if (zoneRefusal !== undefined) return { text: zoneRefusal };

    const after = normalizeBound(input.after, "start");
    const before = normalizeBound(input.before, "end");

    if (after === undefined) {
      return { text: `Refused: "${input.after}" is not a date this server can read.` };
    }
    if (before === undefined) {
      return { text: `Refused: "${input.before}" is not a date this server can read.` };
    }
    if (after > before) {
      return { text: "Refused: `after` falls later than `before`, so the window holds no time." };
    }

    // Measured on the wall-clock bounds, before a zone is even resolved: the
    // check exists to refuse a window the server would refuse anyway, and an
    // offset of an hour either way changes no verdict it reaches.
    const tooWide = refuseWideWindow(after, before, session);
    if (tooWide !== undefined) return { text: tooWide };

    const calendarArguments: CalendarGetArguments = {
      accountId: session.accountId,
      ids: null,
      properties: [...CALENDAR_PROPERTIES],
    };

    const calendars = await client.request<GetResponse<Calendar>>(
      [CAPABILITY_CORE, CAPABILITY_CALENDARS],
      ["Calendar/get", calendarArguments, "0"],
    );

    const { zone, origin } = resolveTimeZone(input.timeZone, calendars.list);
    const utcStart = localToUtc(after, zone);
    const utcEnd = localToUtc(before, zone);

    if (utcStart === undefined || utcEnd === undefined) {
      return { text: "Refused: those bounds could not be resolved to an instant in that zone." };
    }

    const answer = await askServer(client, session, utcStart, utcEnd);
    const busy =
      answer === undefined
        ? await readOwnCalendars(client, session, after, before, zone, calendars.list)
        : { intervals: mergeIntervals(toIntervals(answer)), note: undefined };

    const header = [
      `Busy periods from ${formatInstant(utcStart, zone)} to ${formatInstant(utcEnd, zone)}, ` +
        `times in ${zone} (${origin}).`,
      answer === undefined ? `${FALLBACK_SOURCE} ${FALLBACK_LIMITS}` : SERVER_SOURCE,
      ...(busy.note === undefined ? [] : [busy.note]),
    ].join("\n");

    const body =
      busy.intervals.length === 0
        ? "Free: nothing occupies this window."
        : busy.intervals
            .map(
              (interval) =>
                `- ${formatInstant(toUtcDateTime(interval.start), zone)} → ` +
                `${formatInstant(toUtcDateTime(interval.end), zone)}`,
            )
            .join("\n");

    return { text: `${header}\n\n${body}` };
  },
});

/**
 * The server's own answer, or `undefined` when it withholds the method.
 *
 * Only `forbidden` opens the fallback. A transport failure or any other method
 * error travels on: reading calendars in its place would hand back a confident
 * answer built on a request that never ran.
 */
async function askServer(
  client: JmapClient,
  session: JmapSession,
  utcStart: string,
  utcEnd: string,
): Promise<PrincipalGetAvailabilityResponse | undefined> {
  const args: PrincipalGetAvailabilityArguments = {
    accountId: session.accountId,
    // The account is its own principal here: Stalwart sets
    // `currentUserPrincipalId` to the account id, so asking about oneself needs
    // no directory lookup — which matters, because directory queries are the
    // very thing this method's permission is gated on.
    id: session.principalId,
    utcStart,
    utcEnd,
    // Stalwart caps `eventProperties` at `id` and `baseEventId`, so no detail
    // could leak either way. Sending none states the intent: the question is
    // when, never what.
    showDetails: false,
    eventProperties: null,
  };

  try {
    return await client.request<PrincipalGetAvailabilityResponse>(
      [CAPABILITY_CORE, CAPABILITY_CALENDARS, CAPABILITY_PRINCIPALS_AVAILABILITY],
      ["Principal/getAvailability", args, "0"],
    );
  } catch (error) {
    if (error instanceof JmapMethodError && error.type === "forbidden") return undefined;
    throw error;
  }
}

/**
 * The fallback: the account's own events, expanded over the window and folded.
 *
 * Three kinds of event are dropped, each because it occupies no one: a calendar
 * excluded from availability, an event its owner marked free, and a cancelled
 * event.
 */
async function readOwnCalendars(
  client: JmapClient,
  session: JmapSession,
  after: string,
  before: string,
  zone: string,
  calendars: readonly Calendar[],
): Promise<{ intervals: Interval[]; note: string | undefined }> {
  const counted = new Set<Id>(
    calendars
      .filter((calendar) => calendar.includeInAvailability !== "none")
      .map((calendar) => calendar.id),
  );

  const queryArguments: CalendarEventQueryArguments = {
    accountId: session.accountId,
    filter: { after, before },
    sort: [{ property: "start", isAscending: true }],
    position: 0,
    limit: FALLBACK_EVENT_LIMIT,
    calculateTotal: true,
    timeZone: zone,
    // Both bounds are present by construction, which is what the draft demands
    // before it expands anything: a weekly meeting counts once per occurrence.
    expandRecurrences: true,
  };

  const idsFromQuery: ResultReference = {
    resultOf: "0",
    name: "CalendarEvent/query",
    path: "/ids",
  };

  const [query, fetched] = await client.requestMany<[QueryResponse, GetResponse<CalendarEvent>]>(
    [CAPABILITY_CORE, CAPABILITY_CALENDARS],
    [
      ["CalendarEvent/query", queryArguments, "0"],
      [
        "CalendarEvent/get",
        {
          accountId: session.accountId,
          "#ids": idsFromQuery,
          // The four properties a busy period is built from, and no fifth: this
          // path must not be able to render what the server path cannot.
          properties: ["id", "calendarIds", "utcStart", "utcEnd", "freeBusyStatus", "status"],
          timeZone: zone,
        },
        "1",
      ],
    ],
  );

  const blocking = fetched.list.filter(
    (event) =>
      event.freeBusyStatus !== FREE &&
      event.status !== STATUS_CANCELLED &&
      Object.keys(event.calendarIds ?? {}).some((id) => counted.has(id)),
  );

  const note =
    query.total !== undefined && query.total > FALLBACK_EVENT_LIMIT
      ? `Only the first ${FALLBACK_EVENT_LIMIT} of ${query.total} events in this window were read: ` +
        "narrow the window, because the periods below may miss some."
      : undefined;

  return { intervals: mergeIntervals(intervalsOf(blocking)), note };
}

function toIntervals(answer: PrincipalGetAvailabilityResponse): Interval[] {
  return (answer.list ?? []).flatMap((period: BusyPeriod) => {
    const start = Date.parse(period.utcStart);
    const end = Date.parse(period.utcEnd);
    return Number.isNaN(start) || Number.isNaN(end) ? [] : [{ start, end }];
  });
}

/**
 * Refuses a window past what the server accepts, before any method leaves.
 *
 * The bound rides the availability capability as an ISO 8601 duration. A server
 * that states none gets a year: past that, a "when am I free" question is not
 * the question being asked, and the answer would be a wall of periods.
 */
function refuseWideWindow(after: string, before: string, session: JmapSession): string | undefined {
  const capability = session.raw.capabilities[CAPABILITY_PRINCIPALS_AVAILABILITY] as
    | AvailabilityCapability
    | undefined;

  const stated =
    capability?.maxAvailabilityDuration === undefined
      ? undefined
      : parseIsoDuration(capability.maxAvailabilityDuration);

  const maximum = stated ?? DEFAULT_MAX_WINDOW_MS;
  const span = Date.parse(`${before}Z`) - Date.parse(`${after}Z`);

  if (span <= maximum) return undefined;

  const days = Math.ceil(maximum / (24 * 60 * 60 * 1000));
  return `Refused: this server answers availability over at most ${days} day(s), and that window spans ${Math.ceil(span / (24 * 60 * 60 * 1000))}.`;
}
