/**
 * What writing to a calendar takes, shared by the tools that do it.
 *
 * The piece that matters is `buildEventPatch`: a pure function of an event as it
 * was read and of a normalized request, returning the `PatchObject` to send.
 * Correcting an hour must not cost a description, a participant list or a
 * recurrence rule, and an object written whole would erase every property the
 * read did not hand back.
 *
 * Two rules of the draft bind everything below:
 *
 * - `utcStart` is computed and never written. A write states the local `start`,
 *   its `duration` and its `timeZone`, which is also what a recurrence follows.
 * - a patch that is the prefix of another is invalid (RFC 8620 §5.3), so the two
 *   shapes of a family — the map whole, a pointer into it — are never both
 *   emitted.
 *
 * Only `resolveCalendars` and `resolveParticipantIdentities` read the network;
 * everything else is testable without a server.
 */

import type {
  Calendar,
  CalendarEvent,
  CalendarGetArguments,
  CalendarParticipant,
  EventPatch,
  ParticipantIdentity,
  ParticipantIdentityGetArguments,
} from "../../jmap/types/calendars.js";
import type { GetResponse, Id, SetError, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CALENDARS, CAPABILITY_CORE } from "../../jmap/types/core.js";
import type { ToolContext } from "../../registry/define-tool.js";
import type { BatchSubject } from "../../shared/batch.js";
import { renderTable } from "../../shared/render.js";
import { CALENDAR_PROPERTIES } from "./event.js";

/** One read per handler invocation, whichever hook asks for the calendars first. */
export const CALENDARS_KEY = "calendar:calendars";

/** One read per handler invocation, for the identities the account schedules as. */
export const IDENTITIES_KEY = "calendar:identities";

/** What a batch of events is made of, for the refusal every writing tool shares. */
export const CALENDAR_EVENTS: BatchSubject = {
  noun: "event",
  discoveredBy: "calendar_search",
};

/**
 * The properties a write needs to see before it can be built.
 *
 * `utcStart` and `utcEnd` are absent and stay absent: the draft refuses either
 * next to `start` or `duration`, and this list feeds the read that a patch is
 * computed from. `baseEventId` is here so an isolated occurrence can be refused
 * on what the server says rather than on the shape of an id.
 */
export const EVENT_WRITE_PROPERTIES = [
  "id",
  "calendarIds",
  "uid",
  "baseEventId",
  "recurrenceId",
  "title",
  "description",
  "start",
  "duration",
  "timeZone",
  "showWithoutTime",
  "status",
  "freeBusyStatus",
  "organizerCalendarAddress",
  "locations",
  "participants",
  "recurrenceRules",
] as const;

/**
 * One write request, normalized: what to put on the event, in the caller's terms.
 *
 * Participants come as `add` and `remove` rather than as a replacement list, and
 * a removal names the address to drop rather than the key that holds it: those
 * keys are opaque, and no tool of this server ever shows them.
 */
export interface EventEdit {
  title?: string | undefined;
  description?: string | undefined;
  /** LocalDateTime, already normalized. Written with `timeZone`, never alone. */
  start?: string | undefined;
  /** ISO 8601 duration. */
  duration?: string | undefined;
  /** IANA name. Stated on every write that states a `start`. */
  timeZone?: string | undefined;
  allDay?: boolean | undefined;
  location?: string | undefined;
  status?: string | undefined;
  freeBusyStatus?: string | undefined;
  participantsAdd?: readonly string[] | undefined;
  participantsRemove?: readonly string[] | undefined;
}

/** Who the account schedules as, once one identity has been proven to apply. */
export interface EventOrganizer {
  calendarAddress: string;
  name?: string | undefined;
}

/**
 * The patch one event is to receive, keyed by JSON pointer.
 *
 * Scalars are written at the top level, which is where JSCalendar holds them.
 * Only the keyed families need a shape decision, and it follows what the event
 * already carries, because RFC 8620 §5.3 requires every segment of a pointer but
 * the last to exist:
 *
 * - the parent map is there   → a leaf pointer, `locations/l1/name`
 * - the parent map is absent  → the map whole, `locations`
 */
export function buildEventPatch(event: CalendarEvent, edit: EventEdit): EventPatch {
  const patch: EventPatch = {};

  if (edit.title !== undefined) patch.title = edit.title;
  if (edit.description !== undefined) patch.description = edit.description;
  if (edit.status !== undefined) patch.status = edit.status;
  if (edit.freeBusyStatus !== undefined) patch.freeBusyStatus = edit.freeBusyStatus;
  if (edit.allDay !== undefined) patch.showWithoutTime = edit.allDay;

  if (edit.start !== undefined) patch.start = edit.start;
  if (edit.duration !== undefined) patch.duration = edit.duration;
  // Written whenever it was resolved, even when the hour did not move: an event
  // whose zone is null reads in whichever zone opens it, and a correction that
  // left it null would land the new hour somewhere nobody named.
  if (edit.timeZone !== undefined) patch.timeZone = edit.timeZone;

  patchLocation(patch, event.locations, edit.location);
  patchParticipants(patch, event.participants, edit);

  refusePrefixCollision(patch);
  return patch;
}

/**
 * The object a creation sends: a whole JSCalendar event, since nothing exists
 * to preserve.
 *
 * `isDraft` is never written. The draft only lets it go from true to false, and
 * this server has no use for a one-way lock nothing here can undo.
 *
 * The organizer is stated only when somebody is invited: Stalwart refuses to
 * schedule an event whose organizer is not an identity of the account
 * (`NotOrganizer`), and an event nobody is invited to schedules nothing.
 */
export function buildEventCreation(
  edit: EventEdit,
  calendarIds: readonly Id[],
  organizer?: EventOrganizer,
): Partial<CalendarEvent> {
  const created: Partial<CalendarEvent> = {
    calendarIds: Object.fromEntries(calendarIds.map((id) => [id, true])),
  };

  if (edit.title !== undefined) created.title = edit.title;
  if (edit.description !== undefined) created.description = edit.description;
  if (edit.start !== undefined) created.start = edit.start;
  if (edit.duration !== undefined) created.duration = edit.duration;
  if (edit.timeZone !== undefined) created.timeZone = edit.timeZone;
  if (edit.allDay !== undefined) created.showWithoutTime = edit.allDay;
  if (edit.status !== undefined) created.status = edit.status;
  if (edit.freeBusyStatus !== undefined) created.freeBusyStatus = edit.freeBusyStatus;
  if (edit.location !== undefined) created.locations = { l1: { name: edit.location } };

  const invited = edit.participantsAdd ?? [];
  if (invited.length > 0 && organizer !== undefined) {
    created.organizerCalendarAddress = mailto(organizer.calendarAddress);
    created.participants = {
      p1: ownerParticipant(organizer),
      ...buildParticipants(invited, new Set(["p1"])),
    };
  }

  return created;
}

/**
 * An address becomes a participant.
 *
 * `expectReply` and a status of `needs-action` are what make it an invitation
 * rather than a note: somebody added to an event without either is recorded as
 * attending a meeting they were never asked about.
 */
export function buildParticipants(
  addresses: readonly string[],
  taken: ReadonlySet<string> = new Set(),
): Record<string, CalendarParticipant> {
  const held = new Set(taken);
  const built: Record<string, CalendarParticipant> = {};

  for (const address of addresses) {
    const key = freshKey(held);
    held.add(key);

    built[key] = {
      calendarAddress: mailto(address),
      email: bareAddress(address),
      roles: { attendee: true },
      participationStatus: "needs-action",
      expectReply: true,
    };
  }

  return built;
}

/**
 * Every calendar of the account, read once per handler invocation.
 *
 * The whole list rather than the one calendar a call names: naming a calendar,
 * refusing an unknown one and finding the default all need the neighbours, and
 * asking for them one by one would spend a round trip each time.
 */
export function resolveCalendars(context: ToolContext): Promise<Calendar[]> {
  return context.once(CALENDARS_KEY, async () => {
    const args: CalendarGetArguments = {
      accountId: context.session.accountId,
      ids: null,
      properties: [...CALENDAR_PROPERTIES],
    };

    const response = await context.client.request<GetResponse<Calendar>>(
      [CAPABILITY_CORE, CAPABILITY_CALENDARS],
      ["Calendar/get", args, "0"],
    );

    return response.list;
  });
}

/**
 * The iTIP identities of the account, read once per handler invocation.
 *
 * `ids: null` for the same reason the calendars are read whole: the question is
 * never "is this address mine" but "which of mine is on this event", and that
 * cannot be asked one address at a time.
 */
export function resolveParticipantIdentities(context: ToolContext): Promise<ParticipantIdentity[]> {
  return context.once(IDENTITIES_KEY, async () => {
    const args: ParticipantIdentityGetArguments = {
      accountId: context.session.accountId,
      ids: null,
      properties: ["id", "name", "calendarAddress", "isDefault"],
    };

    const response = await context.client.request<GetResponse<ParticipantIdentity>>(
      [CAPABILITY_CORE, CAPABILITY_CALENDARS],
      ["ParticipantIdentity/get", args, "0"],
    );

    return response.list;
  });
}

/**
 * The calendar a creation lands in when the caller named none.
 *
 * At most one calendar is marked default, and an account where none is and
 * several exist has no answer here: filing an event in a calendar nobody chose
 * is worse than asking.
 */
export function defaultCalendar(calendars: readonly Calendar[]): Calendar | undefined {
  const marked = calendars.find((calendar) => calendar.isDefault === true);
  if (marked !== undefined) return marked;

  return calendars.length === 1 ? calendars[0] : undefined;
}

/** The calendars of the account, named and identified, for a refusal to point at. */
export function describeCalendars(calendars: readonly { id: Id; name: string }[]): string {
  return calendars.length === 0
    ? "no calendar at all"
    : calendars.map((calendar) => `${calendar.name} (${calendar.id})`).join(", ");
}

/** The single participant key the account occupies, or the reason there is none. */
export type ParticipantMatch =
  | { key: string; refusal?: undefined }
  | { key?: undefined; refusal: string };

/**
 * Which participant of this event is the account, proven rather than guessed.
 *
 * Matched on the identities the server hands back, folded on case and on the
 * `mailto:` prefix, because an identity and an invitation are written by two
 * different people and neither owes the other a spelling.
 *
 * Zero matches and several matches both refuse. Picking the first key would
 * answer an invitation on behalf of somebody the caller never named, and there
 * is no undo for a reply that has already left.
 */
export function matchingParticipantKey(
  event: CalendarEvent,
  identities: readonly ParticipantIdentity[],
): ParticipantMatch {
  const mine = new Set(identities.map((identity) => fold(identity.calendarAddress)));

  const matched = Object.entries(event.participants ?? {}).filter(([, participant]) =>
    addressesOf(participant).some((address) => mine.has(address)),
  );

  const [first] = matched;
  if (first === undefined) {
    return {
      refusal:
        `Refused: none of the participants of ${event.id} is an address of this account. ` +
        `The account schedules as ${describeIdentities(identities)}, and answering on behalf ` +
        "of somebody else is not something this server does.",
    };
  }

  if (matched.length > 1) {
    const named = matched
      .map(([, participant]) => addressesOf(participant)[0] ?? "(unnamed)")
      .join(", ");

    return {
      refusal:
        `Refused: ${matched.length} participants of ${event.id} are addresses of this account ` +
        `(${named}), so which one is answering cannot be read off the event. Answer from a ` +
        "client that lets you pick the identity, or remove the duplicate invitation first.",
    };
  }

  return { key: first[0] };
}

/**
 * The refusal an expanded occurrence earns, or nothing when every event is whole.
 *
 * Stalwart accepts a synthetic occurrence id and quietly turns the write into an
 * instance plan, which is a different gesture from the one that was asked for:
 * correcting one Tuesday is not correcting the series, and nothing in the answer
 * would say which happened. The refusal names the base event so the caller has
 * somewhere to go.
 */
export function refuseIsolatedOccurrence(events: readonly CalendarEvent[]): string | undefined {
  const isolated = events.filter(
    (event) => event.baseEventId !== undefined && event.baseEventId !== null,
  );
  if (isolated.length === 0) return undefined;

  const named = isolated
    .map((event) => `${event.id} (occurrence of ${event.baseEventId})`)
    .join(", ");

  return (
    `Refused: ${named} ${isolated.length === 1 ? "is an occurrence" : "are occurrences"} of a ` +
    "recurring event, and this server writes the series rather than a single instance. " +
    "Pass the base event id to act on the whole series."
  );
}

/**
 * Accounts for a `CalendarEvent/set`, id by id.
 *
 * `done` reads as a past participle — "updated", "destroyed" — so one rendering
 * serves every tool. An id absent from the refusals counts as done: the server
 * names what it refused, and reading success off `updated` instead would report
 * an event as untouched on a server that answers with a null patch.
 */
export function describeEventOutcome(
  response: SetResponse<unknown>,
  ids: readonly Id[],
  done: string,
  half: "updated" | "destroyed" = "updated",
): string {
  const refused = (half === "updated" ? response.notUpdated : response.notDestroyed) ?? {};

  const rows = ids.map((id) => {
    const error = refused[id];
    return { id, outcome: error === undefined ? done : `refused: ${describeEventSetError(error)}` };
  });

  // Counted off the server's answer, never off the cell rendered from it: a
  // `done` wording that happened to read like a refusal would move the headline.
  const failed = ids.filter((id) => refused[id] !== undefined).length;
  const succeeded = rows.length - failed;

  const headline =
    failed === 0
      ? `${succeeded} ${plural(succeeded)} ${done}.`
      : succeeded === 0
        ? `No event was ${done}: the server refused all ${rows.length}.`
        : `${succeeded} of ${rows.length} events ${done}, ${failed} refused by the server.`;

  return `${headline}\n\n${renderTable(rows, ["id", "outcome"])}`;
}

/** A `SetError` in one line, wherever a refusal has to be read rather than parsed. */
export function describeEventSetError(error: SetError): string {
  return error.description === undefined ? error.type : `${error.type} — ${error.description}`;
}

/**
 * Two patches where one is the prefix of the other are invalid (RFC 8620 §5.3).
 *
 * Caught here rather than on the wire: the server would answer `invalidPatch`
 * and write nothing, which is the safe outcome but tells the caller nothing
 * about which two parts of their request contradict each other.
 *
 * Exported and tested on its own. No builder above can produce such a pair
 * today, and this is what keeps that true as fields are added rather than a
 * property somebody has to remember.
 */
export function refusePrefixCollision(patch: EventPatch): void {
  const keys = Object.keys(patch);

  for (const key of keys) {
    const nested = keys.find((other) => other.startsWith(`${key}/`));
    if (nested !== undefined) {
      throw new Error(
        `calendar: the patch would carry both ${key} and ${nested}, and a patch that is the ` +
          "prefix of another is invalid. Replacing a family and amending it in the same call " +
          "cannot both be honoured — do one or the other.",
      );
    }
  }
}

/** The organizer as a participant: attending their own event, expecting no reply. */
function ownerParticipant(organizer: EventOrganizer): CalendarParticipant {
  const participant: CalendarParticipant = {
    calendarAddress: mailto(organizer.calendarAddress),
    email: bareAddress(organizer.calendarAddress),
    roles: { owner: true, attendee: true },
    participationStatus: "accepted",
    expectReply: false,
  };

  if (organizer.name !== undefined) participant.name = organizer.name;
  return participant;
}

/**
 * Corrects the place, on the family shape the event already carries.
 *
 * The first location is the one corrected: an event holds a handful at most, and
 * choosing among them would need a key the caller has never been shown.
 */
function patchLocation(
  patch: EventPatch,
  existing: CalendarEvent["locations"],
  value: string | undefined,
): void {
  if (value === undefined) return;

  if (existing === undefined) {
    patch.locations = { l1: { name: value } };
    return;
  }

  const key = Object.keys(existing)[0];
  if (key === undefined) {
    // The map is there but empty: the last segment is what gets created.
    patch["locations/l1"] = { name: value };
    return;
  }

  patch[`locations/${key}/name`] = value;
}

/**
 * Adds and removes participants.
 *
 * A removal names the address, and every key carrying it is dropped: the keys of
 * a JSCalendar map are opaque, chosen by whoever wrote the event, and a caller
 * who has only ever seen addresses cannot name one.
 */
function patchParticipants(
  patch: EventPatch,
  existing: CalendarEvent["participants"],
  edit: EventEdit,
): void {
  const added = edit.participantsAdd ?? [];
  const removed = edit.participantsRemove ?? [];
  if (added.length === 0 && removed.length === 0) return;

  if (existing === undefined) {
    // Nothing to remove from a family the event does not carry, and nothing to
    // point into either: the map is written whole or not at all.
    if (added.length > 0) patch.participants = buildParticipants(added);
    return;
  }

  const taken = new Set(Object.keys(existing));
  for (const [key, participant] of Object.entries(buildParticipants(added, taken))) {
    taken.add(key);
    patch[`participants/${key}`] = participant;
  }

  const wanted = new Set(removed.map(fold));
  for (const [key, participant] of Object.entries(existing)) {
    if (addressesOf(participant).some((address) => wanted.has(address))) {
      patch[`participants/${key}`] = null;
    }
  }
}

/** Every address one participant answers to, folded for comparison. */
function addressesOf(participant: CalendarParticipant): string[] {
  return [
    participant.calendarAddress,
    participant.email,
    ...Object.values(participant.sendTo ?? {}),
  ]
    .filter((value): value is string => value !== undefined && value.trim() !== "")
    .map(fold);
}

/** The identities of the account, for a refusal that has to name them. */
function describeIdentities(identities: readonly ParticipantIdentity[]): string {
  return identities.length === 0
    ? "no calendar address at all"
    : identities.map((identity) => bareAddress(identity.calendarAddress)).join(", ");
}

/** A key nothing holds yet, so an addition creates rather than replaces. */
function freshKey(taken: ReadonlySet<string>): string {
  for (let index = 1; ; index += 1) {
    const candidate = `p${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The scheme is what iTIP addresses by; a caller writes an address either way.
 *
 * The case of what was typed survives. The local part of an address is
 * case-sensitive per RFC 5321 §2.4, and folding it here would write a different
 * address than the one somebody meant — comparing folds, writing never does.
 */
function mailto(address: string): string {
  return `mailto:${bareAddress(address)}`;
}

function bareAddress(address: string): string {
  const trimmed = address.trim();
  return trimmed.toLowerCase().startsWith("mailto:") ? trimmed.slice("mailto:".length) : trimmed;
}

/** Case and scheme carry no meaning when two addresses are compared. */
function fold(address: string): string {
  return bareAddress(address).toLowerCase();
}

function plural(count: number): string {
  return count === 1 ? "event" : "events";
}
