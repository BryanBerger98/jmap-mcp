/**
 * JMAP for Calendars (draft-ietf-jmap-calendars-28) and the JSCalendar objects
 * it carries (RFC 8984).
 *
 * The draft is still moving, which is why every calendar type lives in this one
 * file: a revision bump is then a single diff rather than a hunt across domains.
 * Only what the domain reads is declared — an event property nobody requests
 * would be typed as present on a response that never carries it.
 *
 * Two rules of the draft are load-bearing here and easy to lose:
 *
 * - `recurrenceOverrides` must never be requested alongside `utcStart` and
 *   `utcEnd`: the server refuses the pair, and the reading tools ask for the
 *   computed bounds on every call. The overrides therefore appear nowhere.
 * - `expandRecurrences` on `CalendarEvent/query` demands both `after` and
 *   `before`. Without a window there is no expansion, so a search without one
 *   returns base events and has to say so.
 *
 * Two more carry the writing side:
 *
 * - `sendSchedulingMessages` decides whether a write leaves the account as mail.
 *   It is required by `CalendarEventSetArguments` and therefore written on every
 *   single `CalendarEvent/set`, including the ones that send nothing: a server
 *   default is not a guarantee, and an absent argument shows up on no test.
 * - `utcStart` is computed by the server and never written. A write states the
 *   local `start`, its `duration` and its `timeZone`; the draft refuses
 *   `utcStart` alongside either, and a recurrence follows wall-clock time rather
 *   than a frozen instant anyway.
 */

import type { Id } from "./core.js";

/**
 * How an account's events count towards its availability.
 *
 * `attending` restricts the answer to the events the account actually attends,
 * which cannot be judged without reading participants. The fallback treats it
 * as `all` and says so rather than guessing.
 */
export type AvailabilityInclusion = "all" | "attending" | "none";

/**
 * What a principal may do to one calendar (draft-ietf-jmap-calendars §4,
 * RFC 9670 §3).
 *
 * Every right is optional: a `Calendar/get` that does not name `shareWith` or
 * `myRights` carries neither, and a response is allowed to be partial.
 *
 * `mayWriteAll` aliases a set of internal ACLs that includes the one behind
 * `mayDelete`, so revoking `mayDelete` makes `mayWriteAll` read back `false`
 * with nothing said about it. `sharing/rights.ts` carries the note.
 */
export interface CalendarRights {
  mayReadFreeBusy?: boolean;
  mayReadItems?: boolean;
  mayWriteAll?: boolean;
  mayWriteOwn?: boolean;
  mayUpdatePrivate?: boolean;
  mayRSVP?: boolean;
  mayShare?: boolean;
  mayDelete?: boolean;
}

/** A named collection of events. `Calendar/get` with `ids: null` returns them all. */
export interface Calendar {
  id: Id;
  name: string;
  description?: string | null;
  color?: string | null;
  sortOrder?: number;
  isDefault?: boolean;
  isVisible?: boolean;
  isSubscribed?: boolean;
  /** IANA name, nullable: an account may leave every calendar floating. */
  timeZone?: string | null;
  includeInAvailability?: AvailabilityInclusion;
  /** Beneficiary principal id to the rights it holds. Only the sharing domain reads it. */
  shareWith?: Record<Id, CalendarRights>;
  /** What this account may do to the calendar, as the server computes it. */
  myRights?: CalendarRights;
}

export interface CalendarLocation {
  name?: string;
  description?: string;
  locationTypes?: Record<string, boolean>;
  timeZone?: string | null;
  coordinates?: string;
}

export interface CalendarVirtualLocation {
  name?: string;
  description?: string;
  uri?: string;
}

/**
 * One participant of an event.
 *
 * `name` is optional in RFC 8984 and frequently absent on an invitation sent to
 * an address book entry nobody named, so every renderer falls back on `email`.
 *
 * `calendarAddress` and `email` both exist and are not interchangeable: the
 * first is the iTIP identity a scheduling message is addressed to, the second is
 * a display coordinate. A write states the first; a read falls back on either.
 */
export interface CalendarParticipant {
  name?: string;
  email?: string;
  /** `mailto:` URI, and what an identity of the account is matched against. */
  calendarAddress?: string;
  /** Delivery methods, keyed by name — `imip` for mail. Read, never written. */
  sendTo?: Record<string, string>;
  kind?: string;
  roles?: Record<string, boolean>;
  participationStatus?: string;
  participationComment?: string;
  expectReply?: boolean;
}

/**
 * A recurrence rule, declared for its head properties alone.
 *
 * The reading tools never render a rule: they say an event repeats and let the
 * expansion answer when. Typing the whole RFC 8984 rule would promise a
 * rendering this module does not do.
 */
export interface CalendarRecurrenceRule {
  frequency: string;
  interval?: number;
  count?: number;
  until?: string;
}

/**
 * An event: a JSCalendar object plus the JMAP properties of the draft.
 *
 * `utcStart` and `utcEnd` are computed by the server and are what every
 * rendering reads. The JSCalendar local start, its duration and its own zone are
 * absent on purpose: that zone may be null, so ordering or displaying a local
 * time without the server's computation would be guesswork.
 */
export interface CalendarEvent {
  id: Id;
  calendarIds?: Record<Id, boolean>;
  uid?: string;
  /** Set on an expanded occurrence: the id of the event carrying the rule. */
  baseEventId?: Id | null;
  /** Set on an occurrence: the local start of the instance it stands for. */
  recurrenceId?: string | null;
  title?: string;
  description?: string;
  /** LocalDateTime, read in `timeZone`. What a write states, `utcStart` never. */
  start?: string;
  /** ISO 8601 duration, `PT1H`. Paired with `start`, never with `utcStart`. */
  duration?: string;
  /** IANA name, nullable: an event may float, meaning every zone reads it alike. */
  timeZone?: string | null;
  showWithoutTime?: boolean;
  status?: string;
  freeBusyStatus?: string;
  /** The iTIP identity organizing the event, as a `mailto:` URI. */
  organizerCalendarAddress?: string;
  /**
   * Held in the type so nothing writes it by accident.
   *
   * The draft only lets it go from true to false, never back: an event created
   * as a draft can be released, and one released can never be locked again.
   * This server has no use for that one-way door, so no call sets it.
   */
  isDraft?: boolean;
  privacy?: string;
  locations?: Record<string, CalendarLocation>;
  virtualLocations?: Record<string, CalendarVirtualLocation>;
  participants?: Record<string, CalendarParticipant>;
  /** Null on an expanded occurrence: the server resolved the rule already. */
  recurrenceRules?: CalendarRecurrenceRule[] | null;
  utcStart?: string;
  utcEnd?: string;
  created?: string;
  updated?: string;
}

/**
 * The `CalendarEvent/query` conditions the domain sends.
 *
 * `after` and `before` are LocalDateTime, read in the `timeZone` argument of the
 * query rather than carrying a zone of their own.
 */
export interface CalendarEventFilterCondition {
  inCalendar?: Id;
  after?: string;
  before?: string;
  text?: string;
  title?: string;
  description?: string;
  location?: string;
  owner?: string;
  attendee?: string;
  uid?: string;
}

export type CalendarEventQueryArguments = {
  accountId: Id;
  filter?: CalendarEventFilterCondition;
  /** Stalwart refuses `created` and `updated` unless recurrences are expanded. */
  sort?: { property: string; isAscending: boolean }[];
  position?: number;
  limit?: number;
  calculateTotal?: boolean;
  /** The zone the local bounds of the filter are read in. */
  timeZone?: string;
  /** Refused unless the filter carries both `after` and `before`. */
  expandRecurrences?: boolean;
};

export type CalendarEventGetArguments = {
  accountId: Id;
  ids?: Id[] | null;
  properties?: string[] | null;
  /** The zone the returned local times are expressed in. */
  timeZone?: string;
};

export type CalendarGetArguments = {
  accountId: Id;
  ids?: Id[] | null;
  properties?: string[] | null;
};

/** The patch one event is to receive, keyed by JSON pointer (RFC 8620 §5.3). */
export type EventPatch = Record<string, unknown>;

/**
 * `CalendarEvent/set` arguments.
 *
 * `sendSchedulingMessages` is required here and optional in the draft, on the
 * `onDestroyRemoveEmails` pattern: the draft defaults it to false, and a default
 * is not a guarantee. Making it mandatory means a `CalendarEvent/set` that
 * forgets to state it does not compile, so no write inherits the server's idea
 * of whether mail leaves the account. It is honoured on `destroy` too, where it
 * sends a cancellation to every participant.
 */
export type CalendarEventSetArguments = {
  accountId: Id;
  /** Creation id to object; the server hands back the real id in `created`. */
  create?: Record<Id, Partial<CalendarEvent>>;
  update?: Record<Id, EventPatch>;
  destroy?: Id[];
  sendSchedulingMessages: boolean;
};

/**
 * One iTIP identity of the account: who it is, when it schedules.
 *
 * The address a scheduling message goes out as, and the one a participant of an
 * invitation is matched against. An account carries several, which is why no
 * tool here picks one when the match is ambiguous.
 */
export interface ParticipantIdentity {
  id: Id;
  name?: string;
  /** `mailto:` URI. The draft states one identity per address, not one per name. */
  calendarAddress: string;
  isDefault?: boolean;
}

export type ParticipantIdentityGetArguments = {
  accountId: Id;
  ids?: Id[] | null;
  properties?: string[] | null;
};

/** One stretch of time an account is not free. Carries no event content. */
export interface BusyPeriod {
  utcStart: string;
  utcEnd: string;
  busyStatus?: string;
}

/**
 * `Principal/getAvailability` arguments.
 *
 * `eventProperties` is capped by Stalwart at `id` and `baseEventId`, so a busy
 * period cannot leak a title even when details are asked for. This server sends
 * `null` and `showDetails: false`: the question is when, never what.
 */
export type PrincipalGetAvailabilityArguments = {
  accountId: Id;
  id: Id;
  utcStart: string;
  utcEnd: string;
  showDetails: boolean;
  eventProperties: string[] | null;
};

export interface PrincipalGetAvailabilityResponse {
  accountId: Id;
  list: BusyPeriod[];
}

/**
 * The availability capability, as advertised at session level.
 *
 * `maxAvailabilityDuration` is an ISO 8601 duration and is the only bound the
 * server states on the window: a request past it is refused, so this module
 * checks it before spending a round trip.
 */
export interface AvailabilityCapability {
  maxAvailabilityDuration?: string;
}
