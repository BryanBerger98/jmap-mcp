import { z } from "zod";
import { checkRecipients } from "../../config/recipients.js";
import type {
  Calendar,
  CalendarEvent,
  CalendarEventGetArguments,
  CalendarEventSetArguments,
  EventPatch,
} from "../../jmap/types/calendars.js";
import type { GetResponse, Id, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CALENDARS, CAPABILITY_CORE } from "../../jmap/types/core.js";
import { defineTool, type ToolContext } from "../../registry/define-tool.js";
import { refuseOversizedBatch } from "../../shared/batch.js";
import {
  buildEventCreation,
  buildEventPatch,
  CALENDAR_EVENTS,
  defaultCalendar,
  describeCalendars,
  describeEventOutcome,
  describeEventSetError,
  describeWhen,
  EVENT_WRITE_PROPERTIES,
  type EventEdit,
  type EventOrganizer,
  NAMED_IN_SUMMARY,
  participantsOf,
  refuseIsolatedOccurrence,
  resolveCalendars,
  resolveParticipantIdentities,
  seriesNote,
} from "./edit.js";
import { eventTitle, resolveTimeZone, unknownZoneRefusal } from "./event.js";
import { BOUND_SCHEMA_PATTERN, normalizeBound, parseIsoDuration } from "./time.js";

/** The creation id the server maps to a real one; only ever one per call. */
const CREATION_KEY = "new";

/** What an all-day event lasts when the caller states no duration. */
const ALL_DAY_DURATION = "P1D";

/** What a correction does to a rule-bearing event, for the note that says so. */
const WRITE_REACHES_SERIES = "this write reaches the whole series";

/**
 * The fields that describe one event and cannot be spread over a batch.
 *
 * Marking thirty events busy is a batch gesture; giving thirty events the same
 * title, the same hour or the same place is not, and the refusal names the field
 * that was asked for rather than calling the whole call malformed.
 */
const SINGLE_EVENT_FIELDS = [
  "title",
  "description",
  "start",
  "duration",
  "allDay",
  "location",
] as const;

const inputSchema = z.object({
  eventIds: z
    .array(z.string())
    .optional()
    .describe(
      "The ids of the events to correct, as returned by calendar_search or calendar_read. " +
        "Leave it out to create a new event instead.",
    ),
  calendarId: z
    .string()
    .optional()
    .describe(
      "The calendar a new event lands in, by id as calendar_search lists them. " +
        "Defaults to the calendar this account marks as default.",
    ),
  title: z.string().optional().describe("The title of the event."),
  description: z.string().optional().describe("A free-form description kept on the event."),
  start: z
    .string()
    .regex(BOUND_SCHEMA_PATTERN, { message: "Expected YYYY-MM-DD, or YYYY-MM-DDTHH:MM." })
    .optional()
    .describe(
      "Local start, `2026-09-10T14:00` or a bare date for an all-day event. " +
        "It is a wall-clock time read in timeZone, never an instant.",
    ),
  duration: z
    .string()
    .optional()
    .describe("How long the event lasts, as an ISO 8601 duration: PT1H, PT30M, P1D."),
  timeZone: z
    .string()
    .optional()
    .describe(
      "IANA zone the start is written in, e.g. Europe/Paris — never an offset such as +02:00. " +
        "Defaults to the zone of the default calendar, which the answer always names.",
    ),
  allDay: z
    .boolean()
    .optional()
    .describe("Whether the event covers whole days rather than an hour range."),
  location: z.string().optional().describe("Where the event takes place."),
  status: z
    .enum(["confirmed", "tentative", "cancelled"])
    .optional()
    .describe("The status of the event."),
  freeBusyStatus: z
    .enum(["free", "busy"])
    .optional()
    .describe("Whether the event makes the account busy for availability purposes."),
  participantsAdd: z
    .array(z.string())
    .optional()
    .describe(
      "Email addresses to invite. Adding never overwrites a participant already on the event.",
    ),
  participantsRemove: z
    .array(z.string())
    .optional()
    .describe(
      "Email addresses to remove from the event, given as the address itself, " +
        "never as an internal key.",
    ),
  notify: z
    .boolean()
    .optional()
    .describe(
      "Whether the server should mail invitations or updates to the participants. " +
        "False by default: the event is written and nothing leaves the account.",
    ),
});

type WriteInput = z.infer<typeof inputSchema>;

export const calendarWrite = defineTool({
  name: "calendar_write",
  title: "Create or correct a calendar event",
  description:
    "Creates a calendar event, or corrects the events whose ids are given. " +
    "Only the fields you name are written: the participants, the description and the recurrence " +
    "of an event you correct are left exactly as they were. " +
    "Hours are wall-clock times read in one time zone, which the answer always names. " +
    "notify decides whether participants are mailed about it: false by default, so writing an " +
    "event never sends anything unless you ask for it and confirm it. " +
    "It does not act on a single occurrence of a recurring event — a correction reaches the " +
    "whole series — it does not create or rename calendars, and it writes only in this account.",
  inputSchema,
  // The class is read off `notify` and off nothing else: the same call writes an
  // event either way, and what changes is whether mail leaves the account.
  classes: ["draft", "send"],
  classify: (input) => (input.notify === true ? "send" : "draft"),
  summarize: (input, context) => summarize(input, context),
  precheck: (input, context) => refuse(input, context),
  confirmWhen: (input, context) => {
    const count = (input.eventIds ?? []).length;
    return Promise.resolve(
      count > context.bulkConfirmAbove
        ? `This writes to ${count} events at once, past the ${context.bulkConfirmAbove} this ` +
            "server writes without asking."
        : undefined,
    );
  },
  run: async (input, context) => {
    // Read before writing, and not only because `precheck` already looked: a
    // hook that swallowed a failed read must not have the last word, exactly as
    // in `mail_move` and in the recipient perimeter.
    const refusal = await refuse(input, context);
    if (refusal !== undefined) return { text: refusal };

    return (input.eventIds ?? []).length === 0
      ? createEvent(input, context)
      : correctEvents(input, context);
  },
});

/**
 * Everything that makes the call vain, before anything is written.
 *
 * Shared by `precheck` and `run` rather than written twice: the reads it needs
 * go through `context.once`, so asking twice costs one round trip.
 */
async function refuse(input: WriteInput, context: ToolContext): Promise<string | undefined> {
  const ids = input.eventIds ?? [];

  if (ids.length > 0) {
    const oversized = refuseOversizedBatch(ids, CALENDAR_EVENTS);
    if (oversized !== undefined) return oversized;
  }

  const zoneRefusal = unknownZoneRefusal(input.timeZone);
  if (zoneRefusal !== undefined) return zoneRefusal;

  if (input.start !== undefined && normalizeBound(input.start, "start") === undefined) {
    return `Refused: "${input.start}" is not a date and time this server can read.`;
  }

  if (input.duration !== undefined && parseIsoDuration(input.duration) === undefined) {
    return (
      `Refused: "${input.duration}" is not an ISO 8601 duration. Write it as PT1H for an hour, ` +
      "PT30M for half an hour, P1D for a day."
    );
  }

  if (ids.length > 1) {
    const spread = SINGLE_EVENT_FIELDS.filter((field) => input[field] !== undefined);
    if (spread.length > 0) {
      return (
        `Refused: ${spread.join(", ")} ${spread.length === 1 ? "describes" : "describe"} one ` +
        `event, and ${ids.length} event ids were given. Writing the same value onto every event ` +
        "in a batch is almost never the intent — call once per event, or drop the field and keep " +
        "only status, freeBusyStatus and the participant lists, which do act on a batch."
      );
    }
  }

  if (ids.length === 0) {
    const missing = [
      input.title?.trim() ? undefined : "title",
      input.start === undefined ? "start" : undefined,
      input.duration === undefined && input.allDay !== true ? "duration" : undefined,
    ].filter((field): field is string => field !== undefined);

    if (missing.length > 0) {
      return (
        `Refused: a new event needs ${missing.join(", ")}. An event without a title cannot be ` +
        "told apart in any listing, and one without a start and a length is not a moment in a " +
        "calendar. Pass allDay instead of a duration for an event that covers whole days."
      );
    }

    // A creation has nobody to remove: accepting the list would drop it silently.
    if ((input.participantsRemove ?? []).length > 0) {
      return (
        "Refused: a new event has no participant to remove. Name the people it is to invite " +
        "with participantsAdd, and drop participantsRemove."
      );
    }
  }

  // An invitation is a mail, so the perimeter applies whether or not `notify`
  // is set: the address is written onto the event today and mailed the day
  // somebody corrects it with notify on.
  const invited = input.participantsAdd ?? [];
  if (invited.length > 0) {
    const check = checkRecipients(invited, context.recipients);
    if (!check.ok) return check.refusal;
  }

  if (input.calendarId !== undefined || ids.length === 0) {
    const calendars = await resolveCalendars(context);

    if (input.calendarId !== undefined && !calendars.some((one) => one.id === input.calendarId)) {
      return (
        `Refused: calendar ${input.calendarId} is not in this account, so no event can be ` +
        `written there. The account holds ${describeCalendars(calendars)}.`
      );
    }

    if (
      ids.length === 0 &&
      input.calendarId === undefined &&
      defaultCalendar(calendars) === undefined
    ) {
      return (
        "Refused: this account marks no default calendar, so there is no calendar to put a new " +
        `event in. Name one in calendarId — the account holds ${describeCalendars(calendars)}.`
      );
    }
  }

  if (ids.length === 0) return undefined;

  // The last refusals read the events themselves: whether an id names a whole
  // event or one expanded occurrence is an answer only the server carries, and
  // so is who a correction would mail.
  const events = await readEvents(ids, context);

  const isolated = refuseIsolatedOccurrence(events);
  if (isolated !== undefined) return isolated;

  if (input.notify !== true) return undefined;

  // `sendSchedulingMessages` addresses the participant list the event already
  // carries, never the guests this call happens to add: a correction that
  // notifies mails people `participantsAdd` never names, and the perimeter is
  // about who leaves the account rather than about who an argument spells out.
  const addressed = participantsOf(events);
  if (addressed.length === 0) return undefined;

  const check = checkRecipients(addressed, context.recipients);
  return check.ok ? undefined : check.refusal;
}

/** Creates the event, and says where it landed and in which zone it was read. */
async function createEvent(input: WriteInput, context: ToolContext) {
  const calendars = await resolveCalendars(context);
  const { zone, origin } = resolveTimeZone(input.timeZone, calendars);

  // `refuse` has already established that one of the two exists.
  const calendarId = input.calendarId ?? (defaultCalendar(calendars) as Calendar).id;
  const invited = input.participantsAdd ?? [];
  const organizer = invited.length === 0 ? undefined : await pickOrganizer(context);

  const args: CalendarEventSetArguments = {
    accountId: context.session.accountId,
    create: { [CREATION_KEY]: buildEventCreation(toEdit(input, zone), [calendarId], organizer) },
    sendSchedulingMessages: input.notify === true,
  };

  const response = await context.client.request<SetResponse<CalendarEvent>>(
    [CAPABILITY_CORE, CAPABILITY_CALENDARS],
    ["CalendarEvent/set", args, "0"],
  );

  const created = response.created?.[CREATION_KEY];
  const rejected = response.notCreated?.[CREATION_KEY];

  if (created === undefined) {
    const reason =
      rejected === undefined ? "the server said nothing" : describeEventSetError(rejected);
    return { text: `No event was created: ${reason}.` };
  }

  const calendarName = calendars.find((one) => one.id === calendarId)?.name ?? calendarId;
  const lines = [
    `Created event ${created.id} in ${calendarName}. Times written in ${zone} (${origin}).`,
    schedulingNote(input, invited.length, noIdentityNote(invited.length, organizer)),
  ];

  return { text: lines.filter((line): line is string => line !== undefined).join("\n\n") };
}

/** Corrects each named event, and accounts for every id the server refused. */
async function correctEvents(input: WriteInput, context: ToolContext) {
  const ids = input.eventIds ?? [];
  const calendars = await resolveCalendars(context);
  const { zone, origin } = resolveTimeZone(input.timeZone, calendars);

  const events = await readEvents(ids, context);
  const byId = new Map(events.map((event) => [event.id, event]));
  const edit = toEdit(input, zone);

  const update: Record<Id, EventPatch> = {};
  for (const id of ids) {
    const event = byId.get(id);
    // An event the read did not return is left out of the patch rather than
    // sent a blind one, and left out of the accounting below: the server was
    // never asked about it, so its silence says nothing about that id.
    if (event !== undefined) update[id] = buildEventPatch(event, edit);
  }

  const patched = Object.keys(update);
  const missing = ids.filter((id) => update[id] === undefined);

  const args: CalendarEventSetArguments = {
    accountId: context.session.accountId,
    update,
    sendSchedulingMessages: input.notify === true,
  };

  const response = await context.client.request<SetResponse<CalendarEvent>>(
    [CAPABILITY_CORE, CAPABILITY_CALENDARS],
    ["CalendarEvent/set", args, "0"],
  );

  const written = events.filter((event) => patched.includes(event.id));

  const lines = [
    patched.length === 0 ? undefined : describeEventOutcome(response, patched, "updated"),
    missing.length === 0 ? undefined : `Not found: ${missing.join(", ")}`,
    `Times written in ${zone} (${origin}).`,
    seriesNote(written, WRITE_REACHES_SERIES),
    schedulingNote(input, (input.participantsAdd ?? []).length, noOrganiserNote(written)),
  ];

  return { text: lines.filter((line): line is string => line !== undefined).join("\n\n") };
}

/**
 * The sentence a person reads before confirming.
 *
 * It runs ahead of the refusals, so a read it only needed for its wording
 * degrades to a count rather than failing the call.
 */
async function summarize(input: WriteInput, context: ToolContext): Promise<string> {
  const ids = input.eventIds ?? [];

  if (ids.length === 0) {
    const when = input.start === undefined ? "" : ` on ${input.start}${zoneSuffix(input)}`;
    // Nothing to read on a creation: the event does not exist yet, so everybody
    // it would mail is already named in the arguments.
    return `Create the event "${input.title ?? "(untitled)"}"${when}. ${mailingNote(input, [])}`;
  }

  const counted = `${ids.length} event${ids.length === 1 ? "" : "s"}`;

  try {
    const events = await readEvents(ids, context);

    // The hours are shown as the events themselves state them, in each event's
    // own zone: converting them into one zone for a sentence read at
    // confirmation time would move every hour the reader is checking.
    const named = events
      .slice(0, NAMED_IN_SUMMARY)
      .map((event) => `${eventTitle(event)} (${describeWhen(event)})`)
      .join(", ");

    const more =
      events.length > NAMED_IN_SUMMARY ? `, and ${events.length - NAMED_IN_SUMMARY} more` : "";

    return [
      named === "" ? `Correct ${counted}.` : `Correct ${counted}: ${named}${more}.`,
      input.start === undefined ? undefined : `New start: ${input.start}${zoneSuffix(input)}.`,
      seriesNote(events, WRITE_REACHES_SERIES),
      mailingNote(input, events),
    ]
      .filter((line): line is string => line !== undefined)
      .join(" ");
  } catch {
    return `Correct ${counted}. ${blindMailingNote(input)}`;
  }
}

/**
 * Who a scheduling mail would reach, and how many, before it is confirmed.
 *
 * The union of the guests this call adds and the ones the events already carry:
 * `sendSchedulingMessages` reaches both, and a sentence counting only the
 * additions would understate what leaves, which is the direction that misleads.
 */
function mailingNote(input: WriteInput, events: readonly CalendarEvent[]): string {
  if (input.notify !== true) return "Nothing is mailed to anyone.";

  const addressed = everyoneMailed(input, events);
  return addressed.length === 0
    ? "The server is asked to mail the participants about it, but there is none to reach."
    : `The server is asked to mail ${addressed.length} participant` +
        `${addressed.length === 1 ? "" : "s"} (${addressed.join(", ")}) about it.`;
}

/**
 * The same sentence when the recipients could not be established.
 *
 * A read the summary only needed for its wording never fails the call, and the
 * count left over — the additions alone — would be smaller than what leaves. No
 * number at all is the honest answer.
 */
function blindMailingNote(input: WriteInput): string {
  return input.notify !== true
    ? "Nothing is mailed to anyone."
    : "The server is asked to mail the participants about it, and who they are could not be read.";
}

/** The addresses this call would mail, once each, whichever side they come from. */
function everyoneMailed(input: WriteInput, events: readonly CalendarEvent[]): string[] {
  const seen = new Map<string, string>();

  for (const address of [...(input.participantsAdd ?? []), ...participantsOf(events)]) {
    const trimmed = address.trim();
    if (trimmed === "") continue;

    const folded = trimmed.toLowerCase();
    if (!seen.has(folded)) seen.set(folded, trimmed);
  }

  return [...seen.values()];
}

/**
 * The identity the account schedules as, or nothing when it cannot be settled.
 *
 * A failed read never becomes a refusal here: the event is still worth writing,
 * and the answer says instead that no invitation can go out for it.
 */
async function pickOrganizer(context: ToolContext): Promise<EventOrganizer | undefined> {
  try {
    const identities = await resolveParticipantIdentities(context);
    const chosen =
      identities.find((identity) => identity.isDefault === true) ??
      (identities.length === 1 ? identities[0] : undefined);

    return chosen === undefined
      ? undefined
      : { calendarAddress: chosen.calendarAddress, name: chosen.name };
  } catch {
    return undefined;
  }
}

/**
 * What the call asked of the scheduling side, never what the server did with it.
 *
 * Three conditions swallow an invitation without an error — iTIP turned off, the
 * scheduling permission withheld, an event entirely in the past — so a successful
 * `CalendarEvent/set` proves that the event was written and nothing more.
 *
 * `unsendable` is the reason, if there is one, why the mail has nobody to leave
 * as. Each caller establishes it from what it actually holds — a creation from
 * the identity it settled, a correction from the organiser the events carry —
 * because neither can answer for the path the other took.
 */
function schedulingNote(
  input: WriteInput,
  invited: number,
  unsendable: string | undefined,
): string | undefined {
  if (input.notify !== true) {
    if (invited === 0) return undefined;

    const written =
      `No invitation was requested: the ${invited} participant(s) were written onto the event ` +
      "and nobody was mailed.";

    // Pointing at `notify` would send the caller back for an invitation that
    // cannot leave, so the reason takes its place when there is one.
    return unsendable === undefined
      ? `${written} Call again with notify to have the server mail them.`
      : `${written} ${unsendable}`;
  }

  const asked =
    "The server was asked to mail the participants about it. Whether it did cannot be read from " +
    "its answer: it skips scheduling silently when iTIP is off, when the account lacks the " +
    "scheduling permission, or when the event is entirely in the past.";

  return unsendable === undefined ? asked : `${asked}\n\nNote: ${unsendable}`;
}

/** Why a creation has nobody to send as: no identity of the account was settled. */
function noIdentityNote(
  invited: number,
  organizer: EventOrganizer | undefined,
): string | undefined {
  if (invited === 0 || organizer !== undefined) return undefined;

  return (
    "No scheduling identity of this account could be settled, so the event carries no organiser " +
    "and the server has nobody to send the invitation as."
  );
}

/**
 * Which corrected events name no organiser, read off the events themselves.
 *
 * `organizerCalendarAddress` is in `EVENT_WRITE_PROPERTIES`, so this costs no
 * round trip and states something observed rather than assumed. It says nothing
 * about the account's own identities on purpose: a patch never writes an
 * organiser onto an event, so which identity the account holds could not change
 * what the server has to send as here.
 */
function noOrganiserNote(events: readonly CalendarEvent[]): string | undefined {
  const orphaned = events.filter((event) => (event.organizerCalendarAddress ?? "").trim() === "");
  if (orphaned.length === 0) return undefined;

  const named = orphaned.map((event) => event.id).join(", ");
  return (
    `${named} ${orphaned.length === 1 ? "names" : "name"} no organiser, so the server has nobody ` +
    `to send as for ${orphaned.length === 1 ? "it" : "them"}.`
  );
}

function zoneSuffix(input: WriteInput): string {
  return input.timeZone === undefined ? "" : ` (${input.timeZone})`;
}

/**
 * The tool's arguments as the builders take them.
 *
 * The zone travels with every write that states an hour, resolved rather than
 * left out: an event whose zone is null reads in whichever zone opens it, and a
 * corrected hour would then land somewhere nobody named.
 */
function toEdit(input: WriteInput, zone: string): EventEdit {
  const edit: EventEdit = {
    title: input.title,
    description: input.description,
    status: input.status,
    freeBusyStatus: input.freeBusyStatus,
    allDay: input.allDay,
    location: input.location,
    participantsAdd: input.participantsAdd,
    participantsRemove: input.participantsRemove,
  };

  if (input.start !== undefined) {
    edit.start = normalizeBound(input.start, "start");
  }

  if (input.duration !== undefined) edit.duration = input.duration;
  else if (input.allDay === true && input.start !== undefined) edit.duration = ALL_DAY_DURATION;

  if (input.start !== undefined || input.timeZone !== undefined) edit.timeZone = zone;

  return edit;
}

/**
 * The events a correction is about to patch, read once per handler invocation.
 *
 * Only the properties the patch reasons about, and never `utcStart` or `utcEnd`:
 * the draft refuses either alongside the `start` and `duration` that a write
 * states.
 */
function readEvents(ids: readonly Id[], context: ToolContext): Promise<CalendarEvent[]> {
  return context.once(`calendar:write:${[...ids].sort().join(",")}`, async () => {
    const args: CalendarEventGetArguments = {
      accountId: context.session.accountId,
      ids: [...ids],
      properties: [...EVENT_WRITE_PROPERTIES],
    };

    const response = await context.client.request<GetResponse<CalendarEvent>>(
      [CAPABILITY_CORE, CAPABILITY_CALENDARS],
      ["CalendarEvent/get", args, "0"],
    );

    return response.list;
  });
}
