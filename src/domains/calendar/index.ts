import { CAPABILITY_CALENDARS, CAPABILITY_PRINCIPALS_AVAILABILITY } from "../../jmap/types/core.js";
import { defineDomain } from "../../registry/manifest.js";
import { calendarAvailability } from "./availability.js";
import { calendarRead } from "./read.js";
import { calendarSearch } from "./search.js";

/**
 * search, read.
 *
 * The calendars capability is all these two need: both stay inside
 * `Calendar/get`, `CalendarEvent/query` and `CalendarEvent/get`.
 */
export const calendarDomain = defineDomain({
  name: "calendar",
  requires: [CAPABILITY_CALENDARS],
  tools: [calendarSearch, calendarRead],
});

/**
 * availability.
 *
 * Split off on the `mailSendingDomain` pattern: a second capability, so a server
 * that does not carry `Principal/getAvailability` silences this tool alone
 * rather than the whole domain.
 *
 * The gating is honest about what it proves and no more. Stalwart advertises the
 * availability URI unconditionally, and then refuses the method when directory
 * queries are off — so the capability says the method exists, never that it will
 * answer. That is why the tool carries a fallback of its own.
 */
export const calendarAvailabilityDomain = defineDomain({
  name: "calendar-availability",
  requires: [CAPABILITY_CALENDARS, CAPABILITY_PRINCIPALS_AVAILABILITY],
  tools: [calendarAvailability],
});
