import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { restrictTo } from "../../src/config/recipients.js";
import { calendarDelete } from "../../src/domains/calendar/delete.js";
import type { CalendarEvent } from "../../src/jmap/types/calendars.js";
import type { GetResponse, Invocation, JmapRequest } from "../../src/jmap/types/core.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const events = loadFixture<GetResponse<CalendarEvent>>("calendar-event-writable.json");
const eventSet = loadFixture<Record<string, unknown>>("calendar-event-set.json");

/** The read fixture narrowed to the ids one case is about. */
function only(...ids: string[]): GetResponse<CalendarEvent> {
  return {
    ...events,
    list: events.list.filter((event) => ids.includes(event.id)),
    notFound: ids.filter((id) => !events.list.some((event) => event.id === id)),
  };
}

function calls(requests: JmapRequest[]): Invocation[] {
  return requests.flatMap((request) => request.methodCalls);
}

function named(requests: JmapRequest[], method: string): Invocation[] {
  return calls(requests).filter((call) => call[0] === method);
}

function writeArgs(requests: JmapRequest[]): Record<string, unknown> {
  return named(requests, "CalendarEvent/set")[0]?.[1] as Record<string, unknown>;
}

/** The policy the server ships with, minus the right to send anything. */
const NO_SEND = { ...DEFAULT_POLICY, send: "deny" } as const;

describe("calendar_delete — what it destroys", () => {
  it("destroys the named ids and nothing else, with no update riding along", async () => {
    const { context, requests } = fakeTransport([only("ev-simple"), eventSet]);

    await calendarDelete.run({ ids: ["ev-simple"] }, context);

    expect(writeArgs(requests).destroy).toEqual(["ev-simple"]);
    expect(writeArgs(requests).update).toBeUndefined();
    expect(writeArgs(requests).create).toBeUndefined();
  });

  it("mails nothing by default, and says the participants were not told", async () => {
    const { context, requests } = fakeTransport([only("ev-invited"), eventSet]);

    const result = await calendarDelete.run({ ids: ["ev-invited"] }, context);

    expect(writeArgs(requests).sendSchedulingMessages).toBe(false);
    expect(result.text).toContain("No cancellation was mailed");
  });

  it("asks the server to cancel when notify is given, and says only that it asked", async () => {
    const { context, requests } = fakeTransport([only("ev-invited"), eventSet]);

    const result = await calendarDelete.run({ ids: ["ev-invited"], notify: true }, context);

    expect(writeArgs(requests).sendSchedulingMessages).toBe(true);
    expect(result.text).toContain("asked to mail a cancellation");
    expect(result.text).not.toMatch(/cancellation (was )?sent/i);
  });

  it("separates what the server destroyed from what it refused, id by id", async () => {
    const { context } = fakeTransport([only("ev-invited", "ev-both-identities"), eventSet]);

    const result = await calendarDelete.run({ ids: ["ev-invited", "ev-both-identities"] }, context);

    expect(result.text).toContain("1 of 2 events destroyed");
    expect(result.text).toContain("notFound");
    expect(result.text).toContain("ev-both-identities");
  });

  it("classifies as a destruction whatever notify says", () => {
    expect(calendarDelete.classify({ ids: ["ev-simple"] })).toBe("destroy");
    expect(calendarDelete.classify({ ids: ["ev-simple"], notify: true })).toBe("destroy");
    expect(calendarDelete.classes).toEqual(["destroy"]);
  });
});

describe("calendar_delete — the refusals", () => {
  it("refuses a notifying deletion under a policy that denies sends, before reading", async () => {
    const { context, requests } = fakeTransport([], undefined, undefined, NO_SEND);

    const refusal = await calendarDelete.precheck?.({ ids: ["ev-invited"], notify: true }, context);

    expect(refusal).toContain("policy.send");
    expect(calls(requests)).toEqual([]);
  });

  it("lets a silent deletion through the same policy, since nothing is mailed", async () => {
    const { context } = fakeTransport([only("ev-invited")], undefined, undefined, NO_SEND);

    const refusal = await calendarDelete.precheck?.({ ids: ["ev-invited"] }, context);

    expect(refusal).toBeUndefined();
  });

  it("refuses a batch past the hard ceiling before reading anything", async () => {
    const { context, requests } = fakeTransport([]);
    const ids = Array.from({ length: 51 }, (_, index) => `ev-${index}`);

    const result = await calendarDelete.run({ ids }, context);

    expect(result.text).toContain("batches of 50");
    expect(calls(requests)).toEqual([]);
  });

  it("refuses an isolated occurrence by naming the event that carries the rule", async () => {
    const { context, requests } = fakeTransport([only("ev-series_20260914T093000")]);

    const result = await calendarDelete.run({ ids: ["ev-series_20260914T093000"] }, context);

    expect(result.text).toContain("occurrence of ev-series");
    expect(named(requests, "CalendarEvent/set")).toHaveLength(0);
  });

  it("refuses to cancel towards a participant outside the perimeter", async () => {
    const scope = restrictTo({ fromContacts: ["claire@example.org"], allow: [] });
    const { context, requests } = fakeTransport([only("ev-invited"), eventSet], scope);

    const result = await calendarDelete.run({ ids: ["ev-invited"], notify: true }, context);

    // `paul@example.org` is on the event and in no contact card.
    expect(result.text).toContain("outside the recipient perimeter");
    expect(named(requests, "CalendarEvent/set")).toHaveLength(0);
  });

  it("leaves the perimeter out of a deletion that mails nobody", async () => {
    const scope = restrictTo({ fromContacts: ["claire@example.org"], allow: [] });
    const { context, requests } = fakeTransport([only("ev-invited"), eventSet], scope);

    await calendarDelete.run({ ids: ["ev-invited"] }, context);

    expect(named(requests, "CalendarEvent/set")).toHaveLength(1);
  });

  it("re-refuses in run what a swallowed hook could have let through", async () => {
    const scope = restrictTo({ fromContacts: ["claire@example.org"], allow: [] });
    const { context, requests } = fakeTransport([only("ev-invited"), eventSet], scope);

    const refusal = await calendarDelete.precheck?.({ ids: ["ev-invited"], notify: true }, context);
    const result = await calendarDelete.run({ ids: ["ev-invited"], notify: true }, context);

    expect(refusal).toContain("outside the recipient perimeter");
    expect(result.text).toContain("outside the recipient perimeter");
    expect(named(requests, "CalendarEvent/set")).toHaveLength(0);
  });
});

describe("calendar_delete — what the user is asked", () => {
  it("names the events and their hour, and says nothing is mailed", async () => {
    const { context } = fakeTransport([only("ev-simple")]);

    const summary = await calendarDelete.summarize({ ids: ["ev-simple"] }, context);

    expect(summary).toContain("Permanently delete 1 event");
    expect(summary).toContain("Point budget");
    expect(summary).toContain("2026-09-10T14:00:00 Europe/Paris");
    expect(summary).toContain("No cancellation is mailed");
    expect(summary).toContain("Nothing recovers them");
  });

  it("says how many participants a cancellation reaches, before it is confirmed", async () => {
    const { context } = fakeTransport([only("ev-invited")]);

    const summary = await calendarDelete.summarize({ ids: ["ev-invited"], notify: true }, context);

    // Three participants on the event, each counted once.
    expect(summary).toContain("3 participants");
    expect(summary).toContain("claire@example.org");
    expect(summary).toContain("paul@example.org");
  });

  it("warns that a recurring event disappears whole, series included", async () => {
    const { context } = fakeTransport([only("ev-series")]);

    const summary = await calendarDelete.summarize({ ids: ["ev-series"] }, context);

    expect(summary).toContain("recurring event");
    expect(summary).toContain("whole series disappears");
  });

  it("degrades to a count rather than failing on a read it only needed for words", async () => {
    const { context } = fakeTransport([]);

    const summary = await calendarDelete.summarize({ ids: ["ev-a", "ev-b"] }, context);

    expect(summary).toContain("Permanently delete 2 events");
    expect(summary).toContain("No cancellation is mailed");
  });
});
