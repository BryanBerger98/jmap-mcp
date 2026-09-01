import { z } from "zod";
import type {
  Calendar,
  CalendarEvent,
  CalendarEventFilterCondition,
  CalendarEventQueryArguments,
  CalendarGetArguments,
} from "../../jmap/types/calendars.js";
import type { GetResponse, Id, QueryResponse, ResultReference } from "../../jmap/types/core.js";
import { CAPABILITY_CALENDARS, CAPABILITY_CORE } from "../../jmap/types/core.js";
import { defineTool } from "../../registry/define-tool.js";
import {
  DEFAULT_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  fingerprint,
  inRequestedOrder,
  takeWithinBudget,
} from "../../shared/pagination.js";
import { renderTable } from "../../shared/render.js";
import {
  CALENDAR_PROPERTIES,
  EVENT_ROW_PROPERTIES,
  eventRow,
  renderCalendars,
  resolveTimeZone,
  unknownZoneRefusal,
} from "./event.js";
import { BOUND_SCHEMA_PATTERN, normalizeBound } from "./time.js";

/**
 * How much rendered text one page may spend. Same budget as a contact search:
 * an event row is an hour, a title and a place, which costs about what a card
 * row costs.
 */
const RESULT_BUDGET_CHARS = 3000;

/** `queryMaxResults` defaults to 5000 and is advertised nowhere: always send a limit. */
const MAX_LIMIT = 100;

/**
 * The one order that holds on both sides of the expansion.
 *
 * Stalwart refuses `created` and `updated` unless recurrences are expanded, so
 * a search that pages with a window and one that pages without would otherwise
 * need two different sorts — and two different meanings for the same cursor.
 */
const SORT: CalendarEventQueryArguments["sort"] = [{ property: "start", isAscending: true }];

const SORT_NOTE = "Sorted by start, earliest first.";

const EXPANDED_NOTE =
  "Recurring events are expanded over the window: each line is one occurrence, and its id reads " +
  "like any other in calendar_read.";

const NOT_EXPANDED_NOTE =
  "[no date window: a recurring event shows once as its base event, not as its occurrences. " +
  "Give after and before to see occurrences.]";

const boundField = z.string().regex(BOUND_SCHEMA_PATTERN, {
  message: "Expected YYYY-MM-DD, or YYYY-MM-DDTHH:MM.",
});

const inputSchema = z.object({
  after: boundField
    .optional()
    .describe(
      "Lower bound, local date `2026-09-03` or date and time `2026-09-03T14:00`. A bare date " +
        "starts at 00:00. Give it with `before` to expand recurring events.",
    ),
  before: boundField.optional().describe("Upper bound, same format. A bare date ends at 23:59."),
  timeZone: z
    .string()
    .optional()
    .describe(
      "IANA zone the bounds are read in and the results are shown in, e.g. Europe/Paris. " +
        "Defaults to the zone of the default calendar, which the answer always names.",
    ),
  text: z.string().optional().describe("Substring matched across every searchable field."),
  title: z.string().optional().describe("Substring matched against the title."),
  description: z.string().optional().describe("Substring matched against the description."),
  location: z.string().optional().describe("Substring matched against the locations."),
  attendee: z.string().optional().describe("Address of a participant invited to the event."),
  owner: z.string().optional().describe("Address of the organiser of the event."),
  uid: z.string().optional().describe("Exact iCalendar uid, which every occurrence shares."),
  calendarId: z
    .string()
    .optional()
    .describe("Restrict to one calendar, as listed in the legend this search returns."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Events to fetch, ${DEFAULT_PAGE_SIZE} by default.`),
  cursor: z
    .string()
    .optional()
    .describe("Cursor from a previous page. Resend the same criteria with it, or it is refused."),
});

export const calendarSearch = defineTool({
  name: "calendar_search",
  title: "Search calendar events",
  description:
    "Searches calendar events and returns one line each: when it runs, its title, where, which " +
    "calendar it sits in, and the id `calendar_read` takes. The header lists every calendar of " +
    "the account with its id, so no separate call is needed to discover them. " +
    "Criteria are ANDed and all are optional. Give `after` and `before` to ask what a day or a " +
    "week holds: with both bounds, recurring events are expanded into their occurrences, and " +
    "without them a recurring event shows once as its rule-bearing base. " +
    "Every hour is read and shown in one time zone, which the answer always names. " +
    "A truncated page returns a cursor: pass it back along with the same criteria to continue.",
  inputSchema,
  classes: ["read"],
  classify: () => "read",
  summarize: () => "Search calendar events in the account.",
  run: async (input, { client, session }) => {
    const zoneRefusal = unknownZoneRefusal(input.timeZone);
    if (zoneRefusal !== undefined) return { text: zoneRefusal };

    const after = input.after === undefined ? undefined : normalizeBound(input.after, "start");
    const before = input.before === undefined ? undefined : normalizeBound(input.before, "end");

    if (input.after !== undefined && after === undefined) {
      return { text: `Refused: "${input.after}" is not a date this server can read.` };
    }
    if (input.before !== undefined && before === undefined) {
      return { text: `Refused: "${input.before}" is not a date this server can read.` };
    }
    if (after !== undefined && before !== undefined && after > before) {
      return { text: "Refused: `after` falls later than `before`, so the window holds no time." };
    }

    const filter = buildFilter(input, after, before);
    // Both bounds or nothing: the server refuses an expansion over an open-ended
    // window, and rightly — a weekly meeting has no last occurrence to stop at.
    const expandRecurrences = after !== undefined && before !== undefined;

    // The zone the caller asked for, not the one that gets resolved below: the
    // resolution is deterministic from it, and sealing the resolved zone would
    // mean spending a round trip before a stale cursor could be refused.
    const criteriaFingerprint = fingerprint({
      filter,
      timeZone: input.timeZone,
      expandRecurrences,
    });
    const resumed = input.cursor === undefined ? undefined : decodeCursor(input.cursor);

    if (input.cursor !== undefined && resumed === undefined) {
      return { text: "Refused: that cursor is unreadable. Run the search again from the start." };
    }
    // A position only means something inside the result set that produced it.
    // Checked before the request, so criteria dropped along with the cursor
    // never turn into a walk of the whole calendar served under an old position.
    if (resumed !== undefined && resumed.criteriaFingerprint !== criteriaFingerprint) {
      return {
        text:
          "Refused: that cursor was issued for other criteria, so its position points into a " +
          "different result set. Resend the criteria of the first page with it, or search again " +
          "from the start.",
      };
    }

    const limit = input.limit ?? DEFAULT_PAGE_SIZE;
    const position = resumed?.position ?? 0;

    const calendarArguments: CalendarGetArguments = {
      accountId: session.accountId,
      ids: null,
      properties: [...CALENDAR_PROPERTIES],
    };

    // The calendars travel alone, ahead of the query, and this is the one place
    // in the codebase that spends a second round trip on purpose: the `timeZone`
    // argument of `CalendarEvent/query` is derived from the calendars, and a
    // back-reference fills an argument from a path in an earlier result, never
    // from a value computed between the two.
    const calendars = await client.request<GetResponse<Calendar>>(
      [CAPABILITY_CORE, CAPABILITY_CALENDARS],
      ["Calendar/get", calendarArguments, "0"],
    );

    const { zone, origin } = resolveTimeZone(input.timeZone, calendars.list);

    const queryArguments: CalendarEventQueryArguments = {
      accountId: session.accountId,
      sort: SORT,
      position,
      limit,
      calculateTotal: true,
      timeZone: zone,
      expandRecurrences,
      ...(filter === undefined ? {} : { filter }),
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
            properties: [...EVENT_ROW_PROPERTIES],
            timeZone: zone,
          },
          "1",
        ],
      ],
    );

    if (resumed !== undefined && resumed.queryState !== query.queryState) {
      return {
        text:
          "Refused: the calendars changed since that cursor was issued, so the next page would " +
          "skip or repeat events. Run the search again from the start.",
      };
    }

    const byId = new Map<Id, Calendar>(calendars.list.map((calendar) => [calendar.id, calendar]));
    const events = inRequestedOrder(query.ids, fetched.list);
    const { taken, remaining } = takeWithinBudget(
      events,
      (event) => Object.values(eventRow(event, zone, byId)).join("  "),
      RESULT_BUDGET_CHARS,
    );

    const count =
      query.total === undefined
        ? `${taken.length} event(s) shown.`
        : `${query.total} event(s) match, ${taken.length} shown from position ${position}.`;

    const header = [
      `${count} ${SORT_NOTE} Times in ${zone} (${origin}).`,
      renderCalendars(calendars.list),
      expandRecurrences ? EXPANDED_NOTE : NOT_EXPANDED_NOTE,
    ].join("\n");

    const table = renderTable(
      taken.map((event) => eventRow(event, zone, byId)),
      ["when", "title", "where", "calendar", "id"],
    );
    const text = `${header}\n\n${table}`;

    // A short page ends the run, and so does a full page that lands exactly on
    // the total: without that second test, the last page still hands back a
    // cursor and the client spends a round trip to be told the set is empty.
    const reachedTotal = query.total !== undefined && position + taken.length >= query.total;
    const exhausted = remaining === 0 && (query.ids.length < limit || reachedTotal);
    if (exhausted) return { text };

    return {
      text,
      nextCursor: encodeCursor({
        position: position + taken.length,
        queryState: query.queryState,
        criteriaFingerprint,
      }),
    };
  },
});

/**
 * Maps the input onto the draft's conditions, or to nothing at all.
 *
 * An absent filter walks the whole calendar the way an absent one walks a whole
 * address book: it is what consulting an agenda without a question looks like.
 */
function buildFilter(
  input: z.infer<typeof inputSchema>,
  after: string | undefined,
  before: string | undefined,
): CalendarEventFilterCondition | undefined {
  const filter: CalendarEventFilterCondition = {};

  if (after !== undefined) filter.after = after;
  if (before !== undefined) filter.before = before;
  if (input.text !== undefined) filter.text = input.text;
  if (input.title !== undefined) filter.title = input.title;
  if (input.description !== undefined) filter.description = input.description;
  if (input.location !== undefined) filter.location = input.location;
  if (input.attendee !== undefined) filter.attendee = input.attendee;
  if (input.owner !== undefined) filter.owner = input.owner;
  if (input.uid !== undefined) filter.uid = input.uid;
  if (input.calendarId !== undefined) filter.inCalendar = input.calendarId;

  return Object.keys(filter).length > 0 ? filter : undefined;
}
