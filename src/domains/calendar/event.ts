/**
 * Calendars and events to compact text.
 *
 * The three calendar tools render the same event, the same calendar legend and
 * the same zone chain. Written once here so they cannot diverge at the first
 * correction, and written without a JMAP client: nothing in this file reads the
 * network.
 */

import type { Calendar, CalendarEvent, CalendarParticipant } from "../../jmap/types/calendars.js";
import type { Id } from "../../jmap/types/core.js";
import { renderFields, truncate } from "../../shared/render.js";
import { describeDuration, formatRange, instantOf, isValidTimeZone, UTC_FALLBACK } from "./time.js";

/** What every tool needs from `Calendar/get`: the legend, and the zone chain. */
export const CALENDAR_PROPERTIES = [
  "id",
  "name",
  "color",
  "timeZone",
  "isDefault",
  "isVisible",
  "isSubscribed",
  "includeInAvailability",
] as const;

/**
 * What one search row shows.
 *
 * `recurrenceOverrides` is absent here and everywhere else: the draft refuses it
 * alongside `utcStart` and `utcEnd`, which every rendering below reads.
 */
export const EVENT_ROW_PROPERTIES = [
  "id",
  "calendarIds",
  "title",
  "utcStart",
  "utcEnd",
  "showWithoutTime",
  "status",
  "locations",
  "recurrenceRules",
] as const;

/** What one detail block shows, on top of the row properties. */
export const EVENT_DETAIL_PROPERTIES = [
  "id",
  "calendarIds",
  "uid",
  "baseEventId",
  "recurrenceId",
  "title",
  "description",
  "showWithoutTime",
  "status",
  "freeBusyStatus",
  "privacy",
  "locations",
  "virtualLocations",
  "participants",
  "recurrenceRules",
  "utcStart",
  "utcEnd",
] as const;

const STATUS_CONFIRMED = "confirmed";
const PRIVACY_PUBLIC = "public";
const DESCRIPTION_LIMIT = 400;

/** The zone an answer is expressed in, and where that zone came from. */
export interface ZoneChoice {
  zone: string;
  origin: string;
}

/**
 * The refusal an unknown zone earns, or nothing when the name is usable.
 *
 * Raised before any request: a bad zone name silently replaced by a good one
 * would shift every hour in the answer without an error to show for it.
 */
export function unknownZoneRefusal(requested: string | undefined): string | undefined {
  if (requested === undefined || isValidTimeZone(requested)) return undefined;

  return (
    `Refused: "${requested}" is not a time zone this server knows. ` +
    "Use an IANA name such as Europe/Paris or America/New_York."
  );
}

/**
 * Which zone reads the local hours of this answer.
 *
 * The chain is explicit down to UTC and its outcome is always named, because
 * every link of it is a defensible guess and none of them is the caller's: a
 * calendar may leave `timeZone` null, and an account may have no calendar at
 * all. `requested` is assumed already checked by `unknownZoneRefusal`.
 */
export function resolveTimeZone(
  requested: string | undefined,
  calendars: readonly Calendar[],
): ZoneChoice {
  if (requested !== undefined) return { zone: requested, origin: "as requested" };

  const byDefault = calendars.find((calendar) => calendar.isDefault === true && zoneOf(calendar));
  if (byDefault !== undefined) {
    return {
      zone: zoneOf(byDefault) as string,
      origin: `from the default calendar ${byDefault.name}`,
    };
  }

  const anyCalendar = calendars.find((calendar) => zoneOf(calendar));
  if (anyCalendar !== undefined) {
    return { zone: zoneOf(anyCalendar) as string, origin: `from the calendar ${anyCalendar.name}` };
  }

  return { zone: UTC_FALLBACK, origin: "by fallback: no calendar states one" };
}

function zoneOf(calendar: Calendar): string | undefined {
  const zone = calendar.timeZone?.trim();
  return zone !== undefined && zone !== "" && isValidTimeZone(zone) ? zone : undefined;
}

/**
 * The legend an answer puts in its header: which calendars exist, and their ids.
 *
 * The id is what `calendar_search` takes back as `calendarId`, so naming a
 * calendar without it would describe a filter the caller cannot express.
 */
export function renderCalendars(calendars: readonly Calendar[]): string {
  if (calendars.length === 0) return "Calendars: (none)";

  const listed = calendars
    .map((calendar) => {
      const marks = [
        calendar.isDefault === true ? "default" : undefined,
        calendar.timeZone ?? undefined,
        calendar.isVisible === false ? "hidden" : undefined,
      ].filter((mark): mark is string => mark !== undefined);

      return `${calendar.name} (${[calendar.id, ...marks].join(", ")})`;
    })
    .join(", ");

  return `Calendars: ${listed}`;
}

/**
 * The calendars one event sits in, by name.
 *
 * A calendar the `get` did not return is rendered as its raw id: inventing a
 * name for it would read as a real calendar, and the id at least resolves.
 */
export function calendarNames(event: CalendarEvent, byId: Map<Id, Calendar>): string[] {
  return Object.keys(event.calendarIds ?? {}).map((id) => byId.get(id)?.name ?? id);
}

/** A title a human can read, whatever the event carries. */
export function eventTitle(event: CalendarEvent): string {
  const title = event.title?.trim();
  return title !== undefined && title !== "" ? title : "(untitled)";
}

/** One line of a search result. */
export function eventRow(
  event: CalendarEvent,
  zone: string,
  byId: Map<Id, Calendar>,
): Record<string, unknown> {
  const marks = [
    event.status !== undefined && event.status !== STATUS_CONFIRMED ? event.status : undefined,
    repeats(event) ? "repeats" : undefined,
  ].filter((mark): mark is string => mark !== undefined);

  return {
    when: formatRange(event.utcStart, event.utcEnd, zone, event.showWithoutTime === true),
    title: truncate(
      marks.length === 0 ? eventTitle(event) : `${eventTitle(event)} [${marks.join(", ")}]`,
      48,
    ),
    where: truncate(placeOf(event), 28),
    calendar: calendarNames(event, byId).join(", "),
    id: event.id,
  };
}

/** The detail block of one event. Empty fields are dropped, never padded. */
export function renderEvent(event: CalendarEvent, zone: string, byId: Map<Id, Calendar>): string {
  const allDay = event.showWithoutTime === true;

  return renderFields({
    id: event.id,
    title: eventTitle(event),
    when: formatRange(event.utcStart, event.utcEnd, zone, allDay),
    duration: allDay ? "" : (describeDuration(event.utcStart, event.utcEnd) ?? ""),
    "all day": allDay ? "yes" : "",
    // Stated only when it is not the ordinary case: a line repeated on every
    // event stops carrying information by the third one.
    status: event.status === undefined || event.status === STATUS_CONFIRMED ? "" : event.status,
    "shows as": event.freeBusyStatus === "free" ? "free" : "",
    privacy: event.privacy === undefined || event.privacy === PRIVACY_PUBLIC ? "" : event.privacy,
    // The rule itself is never rendered: the reader asked what happens when,
    // and an RRULE is an answer they would have to interpret themselves.
    recurrence: recurrenceNote(event),
    where: placeOf(event),
    online: joinValues(event.virtualLocations, (entry) => entry.uri ?? entry.name),
    description:
      event.description === undefined ? "" : truncate(event.description.trim(), DESCRIPTION_LIMIT),
    participants: renderParticipants(event),
    calendars: calendarNames(event, byId).join(", "),
    uid: event.uid,
  });
}

/**
 * Who is coming, and who said so.
 *
 * A participant without a name is rendered by its address: an invitation sent
 * to an address nobody named is ordinary, and an empty line is never an answer.
 */
export function renderParticipants(event: CalendarEvent): string {
  const entries = Object.values(event.participants ?? {});
  if (entries.length === 0) return "";

  return entries.map(describeParticipant).join("; ");
}

function describeParticipant(participant: CalendarParticipant): string {
  const name = participant.name?.trim();
  const email = participant.email?.trim();

  const who =
    name !== undefined && name !== ""
      ? name === email || email === undefined || email === ""
        ? name
        : `${name} <${email}>`
      : (email ?? "(unnamed)");

  const marks = [
    participant.roles?.owner === true ? "organiser" : undefined,
    participant.participationStatus,
  ].filter((mark): mark is string => mark !== undefined && mark !== "");

  return marks.length === 0 ? who : `${who} (${marks.join(", ")})`;
}

function repeats(event: CalendarEvent): boolean {
  return (event.recurrenceRules?.length ?? 0) > 0;
}

/**
 * What an event says about repeating, from the two sides of an expansion.
 *
 * An occurrence handed back by the server carries `baseEventId` and no rule,
 * because the server already resolved the overrides; a base event read directly
 * carries the rule and no occurrence. Both deserve a mention, and neither
 * deserves the rule spelled out.
 */
function recurrenceNote(event: CalendarEvent): string {
  if (event.baseEventId !== undefined && event.baseEventId !== null) {
    const at = event.recurrenceId ?? "";
    return `one occurrence of ${event.baseEventId}${at === "" ? "" : ` (instance ${at})`}`;
  }

  if (!repeats(event)) return "";

  // `until` is a local time in the event's own zone, not an instant: reading it
  // in the zone of the answer would shift a bound that carries no offset to
  // shift. The date is the whole of what it says here.
  const until = event.recurrenceRules?.find((rule) => rule.until !== undefined)?.until;
  const bound = until === undefined ? "" : ` until ${until.slice(0, 10)}`;

  return `repeats${bound}; search a date window to see its occurrences`;
}

function placeOf(event: CalendarEvent): string {
  return joinValues(event.locations, (entry) => entry.name ?? entry.description);
}

function joinValues<T>(
  entries: Record<string, T> | undefined,
  read: (entry: T) => string | undefined,
): string {
  return Object.values(entries ?? {})
    .map(read)
    .filter((value): value is string => value !== undefined && value.trim() !== "")
    .join(", ");
}

/** A stretch of time, in milliseconds since the epoch. */
export interface Interval {
  start: number;
  end: number;
}

/**
 * Folds overlapping stretches into one.
 *
 * Two meetings at the same hour are one busy hour: handing back both would let
 * a reader count two obligations where the account has one, and the question
 * asked was when, not how many.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((interval) => interval.end > interval.start)
    .sort((left, right) => left.start - right.start);

  const merged: Interval[] = [];

  for (const interval of sorted) {
    const last = merged.at(-1);
    // Touching counts as overlapping: an hour ending at 15:00 and one starting
    // at 15:00 leave no free minute between them to report.
    if (last !== undefined && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
      continue;
    }
    merged.push({ ...interval });
  }

  return merged;
}

/** The busy stretches of a list of events, before merging. */
export function intervalsOf(events: readonly CalendarEvent[]): Interval[] {
  return events.flatMap((event) => {
    const start = instantOf(event.utcStart);
    const end = instantOf(event.utcEnd);
    return start === undefined || end === undefined ? [] : [{ start, end }];
  });
}
