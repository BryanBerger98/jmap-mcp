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
 */
export interface CalendarParticipant {
  name?: string;
  email?: string;
  kind?: string;
  roles?: Record<string, boolean>;
  participationStatus?: string;
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
  showWithoutTime?: boolean;
  status?: string;
  freeBusyStatus?: string;
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
