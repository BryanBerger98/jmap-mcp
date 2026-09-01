/**
 * Local dates, zones, and the conversion between them.
 *
 * A calendar bound is a wall-clock time and means nothing until a zone reads it:
 * `CalendarEvent/query` takes LocalDateTime bounds and interprets them in its
 * `timeZone` argument, so an hour sent without one is an hour off by a whole
 * offset with no error to show for it.
 *
 * Written on `Intl` alone. `Temporal` would say all of this in three lines and
 * is not in Node 24, and no dependency is worth carrying for a conversion the
 * platform already knows how to do.
 */

/** The last resort of the zone chain: never guessed, always named in the answer. */
export const UTC_FALLBACK = "Etc/UTC";

/** `2026-09-03`, `2026-09-03T14:00`, or `2026-09-03T14:00:00`. */
const BOUND_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** The shape a tool's schema checks before anything reaches this module. */
export const BOUND_SCHEMA_PATTERN = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Whether the runtime knows this zone.
 *
 * `Intl.DateTimeFormat` throws a RangeError on an unknown IANA name, which is
 * the only validation available: there is no list to check against.
 */
export function isValidTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * Turns a caller's bound into a LocalDateTime the server accepts.
 *
 * A bare date is not a moment: as a lower bound it means the start of the day,
 * as an upper bound the end of it. Asking the caller to spell that out would
 * make "what do I have on Thursday" a question about seconds.
 */
export function normalizeBound(value: string, edge: "start" | "end"): string | undefined {
  const match = BOUND_PATTERN.exec(value.trim());
  if (match === null) return undefined;

  const [, year, month, day, hour, minute, second] = match as unknown as string[];
  if (!isRealDate(Number(year), Number(month), Number(day))) return undefined;

  if (hour === undefined) {
    return `${year}-${month}-${day}T${edge === "start" ? "00:00:00" : "23:59:59"}`;
  }

  if (Number(hour) > 23 || Number(minute) > 59) return undefined;

  return `${year}-${month}-${day}T${hour}:${minute}:${second ?? "00"}`;
}

/**
 * The UTC instant a wall-clock time names in a zone.
 *
 * The offset is read at the instant it applies to, which is circular, so the
 * guess is refined once: a first pass using the offset at the naive instant, a
 * second using the offset the first pass landed on. That second pass is what
 * makes a bound on a daylight-saving weekend land on the right hour.
 */
export function localToUtc(local: string, zone: string): string | undefined {
  const wall = Date.parse(`${local}Z`);
  if (Number.isNaN(wall)) return undefined;

  const first = wall - offsetAt(wall, zone);
  const instant = wall - offsetAt(first, zone);

  return toUtcDateTime(instant);
}

/** `UTCDateTime` as the draft spells it: seconds, no milliseconds, trailing Z. */
export function toUtcDateTime(instant: number): string {
  return `${new Date(instant).toISOString().slice(0, 19)}Z`;
}

/** Milliseconds of an instant the server sent, or `undefined` if unparseable. */
export function instantOf(utc: string | undefined): number | undefined {
  if (utc === undefined) return undefined;
  const parsed = Date.parse(utc);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** `2026-09-03 14:00` in the given zone, or `2026-09-03` for an all-day event. */
export function formatInstant(utc: string, zone: string, dateOnly = false): string {
  const instant = instantOf(utc);
  if (instant === undefined) return utc;

  const at = fieldsIn(instant, zone);
  const date = `${at.year}-${at.month}-${at.day}`;

  return dateOnly ? date : `${date} ${at.hour}:${at.minute}`;
}

/**
 * A start and an end, with the date stated once when both fall on the same day.
 *
 * The zone is not repeated here: it is announced once per answer, because a
 * suffix on every line is a suffix nobody reads by the third one.
 */
export function formatRange(
  startUtc: string | undefined,
  endUtc: string | undefined,
  zone: string,
  dateOnly = false,
): string {
  if (startUtc === undefined) return "(no start)";

  const start = formatInstant(startUtc, zone, dateOnly);
  if (endUtc === undefined) return start;

  const end = formatInstant(endUtc, zone, dateOnly);
  if (start === end) return start;

  const sameDay = start.slice(0, 10) === end.slice(0, 10);
  return sameDay ? `${start} → ${end.slice(11)}` : `${start} → ${end}`;
}

/** How long a span lasts, in the units a reader thinks in. */
export function describeDuration(
  startUtc: string | undefined,
  endUtc: string | undefined,
): string | undefined {
  const start = instantOf(startUtc);
  const end = instantOf(endUtc);
  if (start === undefined || end === undefined || end < start) return undefined;

  const span = end - start;
  if (span === 0) return "0min";
  if (span % DAY_MS === 0) return `${span / DAY_MS}d`;

  const hours = Math.floor(span / HOUR_MS);
  const minutes = Math.round((span % HOUR_MS) / MINUTE_MS);

  if (hours === 0) return `${minutes}min`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}min`;
}

/**
 * An ISO 8601 duration in milliseconds, for the one bound the server states.
 *
 * Years and months are approximated, and deliberately: the value is compared
 * against a requested window to refuse it early, so a few days of drift on a
 * yearly cap changes nothing the server will not check again itself.
 */
export function parseIsoDuration(text: string): number | undefined {
  const match =
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      text.trim(),
    );
  if (match === null || match[0] === "P") return undefined;

  const [, years, months, weeks, days, hours, minutes, seconds] = match as unknown as string[];
  const at = (value: string | undefined): number => (value === undefined ? 0 : Number(value));

  return (
    at(years) * 365 * DAY_MS +
    at(months) * 30 * DAY_MS +
    at(weeks) * 7 * DAY_MS +
    at(days) * DAY_MS +
    at(hours) * HOUR_MS +
    at(minutes) * MINUTE_MS +
    at(seconds) * 1000
  );
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  const known = formatters.get(zone);
  if (known !== undefined) return known;

  // `h23` rather than `hour12: false`: the latter renders midnight as hour 24
  // on some locales, which turns a conversion into a day-long error.
  const built = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  formatters.set(zone, built);
  return built;
}

interface ZonedFields {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function fieldsIn(instant: number, zone: string): ZonedFields {
  const parts = new Map<string, string>(
    partsFormatter(zone)
      .formatToParts(new Date(instant))
      .map((part) => [part.type as string, part.value]),
  );

  const read = (type: string): string => parts.get(type) ?? "00";

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** The zone's offset from UTC at one instant, in milliseconds. */
function offsetAt(instant: number, zone: string): number {
  const at = fieldsIn(instant, zone);

  const asUtc = Date.UTC(
    Number(at.year),
    Number(at.month) - 1,
    Number(at.day),
    Number(at.hour),
    Number(at.minute),
    Number(at.second),
  );

  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Rejects `2026-02-31`, which the pattern happily matches. */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
