import { describe, expect, it } from "vitest";
import { restrictTo } from "../../src/config/recipients.js";
import { calendarWrite } from "../../src/domains/calendar/write.js";
import type {
  Calendar,
  CalendarEvent,
  ParticipantIdentity,
} from "../../src/jmap/types/calendars.js";
import type { GetResponse, Invocation, JmapRequest } from "../../src/jmap/types/core.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const calendars = loadFixture<GetResponse<Calendar>>("calendar-get.json");
const events = loadFixture<GetResponse<CalendarEvent>>("calendar-event-writable.json");
const identities = loadFixture<GetResponse<ParticipantIdentity>>("participant-identity-get.json");
const eventSet = loadFixture<Record<string, unknown>>("calendar-event-set.json");

/** The read fixture narrowed to the ids one case is about. */
function only(...ids: string[]): GetResponse<CalendarEvent> {
  return {
    ...events,
    list: events.list.filter((event) => ids.includes(event.id)),
    notFound: ids.filter((id) => !events.list.some((event) => event.id === id)),
  };
}

/** An account whose calendars carry no default mark, and holds more than one. */
const undecided: GetResponse<Calendar> = {
  accountId: "acc-1",
  state: "calendar-state-2",
  list: [
    { id: "cal-7", name: "Family" },
    { id: "cal-8", name: "Studies" },
  ],
  notFound: [],
};

/** An account that schedules as nobody: no identity can be settled from it. */
const noIdentity: GetResponse<ParticipantIdentity> = {
  accountId: "acc-1",
  state: "identity-state-2",
  list: [],
  notFound: [],
};

function calls(requests: JmapRequest[]): Invocation[] {
  return requests.flatMap((request) => request.methodCalls);
}

function named(requests: JmapRequest[], method: string): Invocation[] {
  return calls(requests).filter((call) => call[0] === method);
}

/** The single `CalendarEvent/set` a case emitted, whatever it carried. */
function writeArgs(requests: JmapRequest[]): Record<string, unknown> {
  return named(requests, "CalendarEvent/set")[0]?.[1] as Record<string, unknown>;
}

function createdEvent(requests: JmapRequest[]): Record<string, unknown> {
  const create = writeArgs(requests).create as Record<string, Record<string, unknown>>;
  return create.new as Record<string, unknown>;
}

function patchOf(requests: JmapRequest[], id: string): Record<string, unknown> {
  const update = writeArgs(requests).update as Record<string, Record<string, unknown>>;
  return update[id] as Record<string, unknown>;
}

const CREATE = { title: "Point budget", start: "2026-09-10T14:00", duration: "PT1H" };

describe("calendar_write — creating", () => {
  it("writes the local hour, its length and the zone that reads it", async () => {
    const { context, requests } = fakeTransport([calendars, eventSet]);

    await calendarWrite.run(CREATE, context);
    const created = createdEvent(requests);

    expect(created.title).toBe("Point budget");
    // Normalized to seconds, which is what a LocalDateTime is on the wire.
    expect(created.start).toBe("2026-09-10T14:00:00");
    expect(created.duration).toBe("PT1H");
    expect(created.timeZone).toBe("Europe/Paris");
    // `utcStart` is computed by the server and refused next to `start`.
    expect(Object.keys(created).join(" ")).not.toContain("utc");
  });

  it("asks for no scheduling of its own accord", async () => {
    const { context, requests } = fakeTransport([calendars, eventSet]);

    await calendarWrite.run(CREATE, context);

    expect(writeArgs(requests).sendSchedulingMessages).toBe(false);
    expect(named(requests, "ParticipantIdentity/get")).toHaveLength(0);
  });

  it("names where the event landed and in which zone it was read", async () => {
    const { context } = fakeTransport([calendars, eventSet]);

    const result = await calendarWrite.run(CREATE, context);

    expect(result.text).toContain("ev-new-1");
    expect(result.text).toContain("Personal");
    expect(result.text).toContain("Europe/Paris");
    expect(result.text).toContain("from the default calendar");
  });

  it("gives an all-day event a day, without being told how long a day is", async () => {
    const { context, requests } = fakeTransport([calendars, eventSet]);

    await calendarWrite.run({ title: "Congés", start: "2026-09-14", allDay: true }, context);
    const created = createdEvent(requests);

    expect(created.showWithoutTime).toBe(true);
    expect(created.start).toBe("2026-09-14T00:00:00");
    expect(created.duration).toBe("P1D");
  });

  it("files the event in the calendar it was given rather than the default one", async () => {
    const { context, requests } = fakeTransport([calendars, eventSet]);

    const result = await calendarWrite.run({ ...CREATE, calendarId: "cal-2" }, context);

    expect(createdEvent(requests).calendarIds).toEqual({ "cal-2": true });
    expect(result.text).toContain("Work");
  });

  it("states the organizer when it invites, so the server has somebody to send as", async () => {
    const { context, requests } = fakeTransport([calendars, identities, eventSet]);

    await calendarWrite.run(
      { ...CREATE, participantsAdd: ["noor@example.org"], notify: true },
      context,
    );
    const created = createdEvent(requests);

    expect(created.organizerCalendarAddress).toBe("mailto:Bryan@Example.COM");
    expect(writeArgs(requests).sendSchedulingMessages).toBe(true);
  });

  it("says an invitation was asked for, never that one was sent", async () => {
    const { context } = fakeTransport([calendars, identities, eventSet]);

    const result = await calendarWrite.run(
      { ...CREATE, participantsAdd: ["noor@example.org"], notify: true },
      context,
    );

    expect(result.text).toContain("asked to mail");
    expect(result.text).toMatch(/iTIP/);
    expect(result.text).not.toMatch(/invitation (was )?sent/i);
  });

  it("says so when no identity of the account can carry the invitation", async () => {
    const { context } = fakeTransport([calendars, noIdentity, eventSet]);

    const result = await calendarWrite.run(
      { ...CREATE, participantsAdd: ["noor@example.org"], notify: true },
      context,
    );

    expect(result.text).toContain("no scheduling identity");
  });

  it("writes the guests without mailing them when notify is left out", async () => {
    const { context, requests } = fakeTransport([calendars, identities, eventSet]);

    const result = await calendarWrite.run(
      { ...CREATE, participantsAdd: ["noor@example.org"] },
      context,
    );

    expect(writeArgs(requests).sendSchedulingMessages).toBe(false);
    expect(result.text).toContain("No invitation was requested");
  });

  it("reports the server's own refusal rather than a success it did not grant", async () => {
    const { context } = fakeTransport([
      calendars,
      { notCreated: { new: { type: "forbidden", description: "Read-only calendar." } } },
    ]);

    const result = await calendarWrite.run(CREATE, context);

    expect(result.text).toContain("No event was created");
    expect(result.text).toContain("Read-only calendar.");
  });
});

describe("calendar_write — correcting", () => {
  it("touches the three properties an hour needs and nothing else", async () => {
    const { context, requests } = fakeTransport([only("ev-simple"), calendars, eventSet]);

    await calendarWrite.run(
      { eventIds: ["ev-simple"], start: "2026-09-10T16:00", duration: "PT2H" },
      context,
    );

    expect(patchOf(requests, "ev-simple")).toEqual({
      start: "2026-09-10T16:00:00",
      duration: "PT2H",
      timeZone: "Europe/Paris",
    });
  });

  it("leaves the participants, the description and the recurrence out of the patch", async () => {
    const { context, requests } = fakeTransport([only("ev-invited"), calendars, eventSet]);

    await calendarWrite.run({ eventIds: ["ev-invited"], status: "tentative" }, context);
    const keys = Object.keys(patchOf(requests, "ev-invited")).join(" ");

    for (const untouched of ["participants", "description", "recurrenceRules", "locations"]) {
      expect(keys).not.toContain(untouched);
    }
  });

  it("reads only the properties a patch is computed from", async () => {
    const { context, requests } = fakeTransport([only("ev-simple"), calendars, eventSet]);

    await calendarWrite.run({ eventIds: ["ev-simple"], title: "Point budget Q4" }, context);
    const properties = named(requests, "CalendarEvent/get")[0]?.[1]?.properties as string[];

    expect(properties).toContain("participants");
    expect(properties.join(" ")).not.toContain("utc");
  });

  it("says out loud that correcting a series reaches every occurrence", async () => {
    const { context } = fakeTransport([only("ev-series"), calendars, eventSet]);

    const result = await calendarWrite.run(
      { eventIds: ["ev-series"], start: "2026-09-07T10:00" },
      context,
    );

    expect(result.text).toContain("whole series");
    expect(result.text).toContain("ev-series");
  });

  it("restates the zone the hour was read in", async () => {
    const { context } = fakeTransport([only("ev-simple"), calendars, eventSet]);

    const result = await calendarWrite.run(
      { eventIds: ["ev-simple"], start: "2026-09-10T16:00", timeZone: "America/New_York" },
      context,
    );

    expect(result.text).toContain("Times written in America/New_York (as requested)");
  });

  it("accounts for an id the read never returned, without patching it blind", async () => {
    const { context, requests } = fakeTransport([only("ev-simple"), calendars, eventSet]);

    const result = await calendarWrite.run(
      { eventIds: ["ev-simple", "ev-gone"], freeBusyStatus: "free" },
      context,
    );

    expect(Object.keys(writeArgs(requests).update as object)).toEqual(["ev-simple"]);
    expect(result.text).toContain("Not found: ev-gone");
  });

  it("renders the server's refusals by id, never a global success", async () => {
    const { context } = fakeTransport([only("ev-simple", "ev-series"), calendars, eventSet]);

    const result = await calendarWrite.run(
      { eventIds: ["ev-simple", "ev-series"], freeBusyStatus: "busy" },
      context,
    );

    expect(result.text).toContain("1 of 2 events updated");
    expect(result.text).toContain("may not write to this calendar");
  });
});

describe("calendar_write — the refusals", () => {
  it("refuses an unknown zone before any request", async () => {
    const { context, requests } = fakeTransport([]);

    const refusal = await calendarWrite.precheck?.({ ...CREATE, timeZone: "Paris" }, context);

    expect(refusal).toContain("not a time zone this server knows");
    expect(calls(requests)).toEqual([]);
  });

  it("refuses a bound it cannot read", async () => {
    const { context } = fakeTransport([]);

    const refusal = await calendarWrite.precheck?.({ ...CREATE, start: "2026-02-31" }, context);

    expect(refusal).toContain("not a date and time");
  });

  it("refuses a duration that is not an ISO 8601 one", async () => {
    const { context } = fakeTransport([]);

    const refusal = await calendarWrite.precheck?.({ ...CREATE, duration: "1h" }, context);

    expect(refusal).toContain("PT1H");
  });

  it("refuses a creation that names no moment", async () => {
    const { context } = fakeTransport([]);

    const refusal = await calendarWrite.precheck?.({ title: "Atelier" }, context);

    expect(refusal).toContain("start");
    expect(refusal).toContain("duration");
  });

  it("refuses a creation that removes a participant it never had", async () => {
    const { context } = fakeTransport([]);

    const refusal = await calendarWrite.precheck?.(
      { ...CREATE, participantsRemove: ["paul@example.org"] },
      context,
    );

    expect(refusal).toContain("no participant to remove");
  });

  it("refuses a calendar the account does not hold, and names the ones it does", async () => {
    const { context } = fakeTransport([calendars]);

    const refusal = await calendarWrite.precheck?.({ ...CREATE, calendarId: "cal-99" }, context);

    expect(refusal).toContain("cal-99");
    expect(refusal).toContain("Personal (cal-1)");
  });

  it("refuses a creation when no calendar is marked default and none was named", async () => {
    const { context } = fakeTransport([undecided]);

    const refusal = await calendarWrite.precheck?.(CREATE, context);

    expect(refusal).toContain("marks no default calendar");
    expect(refusal).toContain("Family (cal-7)");
  });

  it("refuses an hour spread over a batch, and names the field", async () => {
    const { context, requests } = fakeTransport([]);

    const refusal = await calendarWrite.precheck?.(
      { eventIds: ["ev-1", "ev-2"], start: "2026-09-10T09:00" },
      context,
    );

    expect(refusal).toContain("start");
    expect(refusal).toContain("2 event ids");
    expect(calls(requests)).toEqual([]);
  });

  it("lets a collective field through on the same batch", async () => {
    const { context } = fakeTransport([only("ev-simple", "ev-series")]);

    const refusal = await calendarWrite.precheck?.(
      { eventIds: ["ev-simple", "ev-series"], freeBusyStatus: "busy" },
      context,
    );

    expect(refusal).toBeUndefined();
  });

  it("refuses an isolated occurrence by naming the event that carries the rule", async () => {
    const { context } = fakeTransport([only("ev-series_20260914T093000")]);

    const refusal = await calendarWrite.precheck?.(
      { eventIds: ["ev-series_20260914T093000"], status: "cancelled" },
      context,
    );

    expect(refusal).toContain("occurrence of ev-series");
  });

  it("refuses a participant outside the perimeter, whether or not it would mail them", async () => {
    const scope = restrictTo({ fromContacts: ["paul@example.org"], allow: [] });
    const outside = { ...CREATE, participantsAdd: ["stranger@example.net"] };

    for (const notify of [false, true]) {
      const { context, requests } = fakeTransport([calendars], scope);

      const refusal = await calendarWrite.precheck?.({ ...outside, notify }, context);

      // The address is written onto the event today and mailed the day somebody
      // corrects it with notify on: the perimeter cannot wait for that call.
      expect(refusal).toContain("outside the recipient perimeter");
      expect(calls(requests)).toEqual([]);
    }
  });

  it("refuses a guest already on the event when a correction is about to mail them", async () => {
    const scope = restrictTo({ fromContacts: ["paul@example.org"], allow: [] });
    const { context } = fakeTransport([only("ev-invited")], scope);

    // Nothing here names a recipient: `sendSchedulingMessages` mails the
    // participant list the event already carries, and claire@example.org is on
    // it without `participantsAdd` ever spelling her out.
    const refusal = await calendarWrite.precheck?.(
      { eventIds: ["ev-invited"], status: "cancelled", notify: true },
      context,
    );

    expect(refusal).toContain("outside the recipient perimeter");
    expect(refusal).toContain("claire@example.org");
  });

  it("leaves the guests already on the event alone when nothing is mailed", async () => {
    const scope = restrictTo({ fromContacts: ["paul@example.org"], allow: [] });
    const { context } = fakeTransport([only("ev-invited")], scope);

    const refusal = await calendarWrite.precheck?.(
      { eventIds: ["ev-invited"], status: "cancelled" },
      context,
    );

    expect(refusal).toBeUndefined();
  });

  it("refuses again inside run, on a hook that swallowed a failed read", async () => {
    const { context, requests } = fakeTransport([calendars]);

    const result = await calendarWrite.run({ ...CREATE, timeZone: "Paris" }, context);

    expect(result.text).toContain("not a time zone this server knows");
    expect(named(requests, "CalendarEvent/set")).toHaveLength(0);
  });
});

describe("calendar_write — what the user is asked", () => {
  it("names the events, up to five, and the number beyond that", async () => {
    const { context } = fakeTransport([only("ev-simple", "ev-series", "ev-invited")]);

    const summary = await calendarWrite.summarize(
      { eventIds: ["ev-simple", "ev-series", "ev-invited"], freeBusyStatus: "busy" },
      context,
    );

    expect(summary).toContain("Correct 3 events");
    expect(summary).toContain("Point budget");
    expect(summary).toContain("Nothing is mailed to anyone.");
  });

  it("names the recipients and their number when it is about to mail them", async () => {
    const { context } = fakeTransport([]);

    const summary = await calendarWrite.summarize(
      { ...CREATE, participantsAdd: ["noor@example.org", "paul@example.org"], notify: true },
      context,
    );

    expect(summary).toContain("2 invitee");
    expect(summary).toContain("noor@example.org");
    expect(summary).toContain("paul@example.org");
  });

  it("says a correction reaches the whole series before it is confirmed", async () => {
    const { context } = fakeTransport([only("ev-series")]);

    const summary = await calendarWrite.summarize(
      { eventIds: ["ev-series"], start: "2026-09-07T10:00" },
      context,
    );

    expect(summary).toContain("whole series");
  });

  it("degrades to a count rather than failing on a read it only needed for words", async () => {
    const { context } = fakeTransport([]);
    // The transport answers `{}` here, so `response.list` is undefined and the
    // read throws: a summary is never worth failing a call over.
    const summary = await calendarWrite.summarize({ eventIds: ["ev-simple"] }, context);

    expect(summary).toContain("Correct 1 event");
  });

  it("asks about volume past the threshold, and stays quiet under it", async () => {
    const { context } = fakeTransport([], undefined, 3);
    const ids = (count: number) => Array.from({ length: count }, (_, index) => `ev-${index}`);

    const under = await calendarWrite.confirmWhen?.({ eventIds: ids(3) }, context);
    const over = await calendarWrite.confirmWhen?.({ eventIds: ids(4) }, context);

    expect(under).toBeUndefined();
    expect(over).toContain("4 events");
  });
});
