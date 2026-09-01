import { z } from "zod";
import type {
  Calendar,
  CalendarEvent,
  CalendarEventGetArguments,
  CalendarGetArguments,
} from "../../jmap/types/calendars.js";
import type { GetResponse, Id } from "../../jmap/types/core.js";
import { CAPABILITY_CALENDARS, CAPABILITY_CORE } from "../../jmap/types/core.js";
import { defineTool } from "../../registry/define-tool.js";
import { inRequestedOrder } from "../../shared/pagination.js";
import {
  CALENDAR_PROPERTIES,
  EVENT_DETAIL_PROPERTIES,
  renderEvent,
  resolveTimeZone,
  unknownZoneRefusal,
} from "./event.js";

/**
 * How many events one call may read.
 *
 * The same ceiling `contacts_read` sets on cards: an event is a handful of
 * fields plus a guest list, so reading a morning at once is a normal gesture
 * rather than a bulk export.
 */
export const MAX_EVENTS = 20;

const SEPARATOR = `\n\n${"-".repeat(60)}\n\n`;

const inputSchema = z.object({
  ids: z
    .array(z.string())
    .min(1)
    .max(MAX_EVENTS)
    .describe(`Event ids returned by calendar_search, ${MAX_EVENTS} at most per call.`),
  timeZone: z
    .string()
    .optional()
    .describe(
      "IANA zone the hours are shown in, e.g. Europe/Paris. Defaults to the zone of the default " +
        "calendar, which the answer always names.",
    ),
});

export const calendarRead = defineTool({
  name: "calendar_read",
  title: "Read calendar events",
  description:
    `Reads up to ${MAX_EVENTS} calendar events by id: hours and duration, place and online link, ` +
    "description, participants with the answer each gave, and the calendars the event sits in. " +
    "An id returned by an expanded search names one occurrence and reads like any other; the " +
    "event that carries the rule says that it repeats, and never spells the rule out. " +
    "This tool takes ids, never a filter: run calendar_search first and read the ids it returned.",
  inputSchema,
  classes: ["read"],
  classify: () => "read",
  summarize: (input) => `Read ${input.ids.length} calendar event(s).`,
  run: async (input, { client, session }) => {
    const zoneRefusal = unknownZoneRefusal(input.timeZone);
    if (zoneRefusal !== undefined) return { text: zoneRefusal };

    const eventArguments: CalendarEventGetArguments = {
      accountId: session.accountId,
      ids: input.ids,
      properties: [...EVENT_DETAIL_PROPERTIES],
      // Sent only when the caller named one. The zone that gets resolved below
      // comes from the calendars fetched in this very round trip, so it cannot
      // ride on this call — and it does not need to: every hour rendered here
      // is read off `utcStart` and `utcEnd`, which carry no zone to begin with.
      ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
    };

    const calendarArguments: CalendarGetArguments = {
      accountId: session.accountId,
      ids: null,
      properties: [...CALENDAR_PROPERTIES],
    };

    // Both calls travel together with no back-reference between them: they are
    // independent, and an event that cannot name its calendar is half a read.
    const [fetched, calendars] = await client.requestMany<
      [GetResponse<CalendarEvent>, GetResponse<Calendar>]
    >(
      [CAPABILITY_CORE, CAPABILITY_CALENDARS],
      [
        ["CalendarEvent/get", eventArguments, "0"],
        ["Calendar/get", calendarArguments, "1"],
      ],
    );

    const { zone, origin } = resolveTimeZone(input.timeZone, calendars.list);
    const byId = new Map<Id, Calendar>(calendars.list.map((calendar) => [calendar.id, calendar]));

    // The caller's order carries intent; the server's answer order carries none.
    const blocks = inRequestedOrder(input.ids, fetched.list).map((event) =>
      renderEvent(event, zone, byId),
    );

    // Named, never dropped: an id that answers nothing is a fact about the
    // caller's list, and silence about it reads as an event with no content.
    if (fetched.notFound.length > 0) {
      blocks.push(`Not found: ${fetched.notFound.join(", ")}`);
    }

    const body = blocks.length > 0 ? blocks.join(SEPARATOR) : "(no event found)";

    // Once for the whole answer, not once per block: the zone is the same for
    // every hour below, and twenty copies of it are twenty ways of not reading it.
    return { text: `Times in ${zone} (${origin}).\n\n${body}` };
  },
});
