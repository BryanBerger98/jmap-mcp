import { describe, expect, it } from "vitest";
import { restrictTo } from "../../src/config/recipients.js";
import { calendarRespond } from "../../src/domains/calendar/respond.js";
import type { CalendarEvent, ParticipantIdentity } from "../../src/jmap/types/calendars.js";
import type { GetResponse, Invocation, JmapRequest } from "../../src/jmap/types/core.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

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

function calls(requests: JmapRequest[]): Invocation[] {
  return requests.flatMap((request) => request.methodCalls);
}

function named(requests: JmapRequest[], method: string): Invocation[] {
  return calls(requests).filter((call) => call[0] === method);
}

function writeArgs(requests: JmapRequest[]): Record<string, unknown> {
  return named(requests, "CalendarEvent/set")[0]?.[1] as Record<string, unknown>;
}

function patchOf(requests: JmapRequest[], id: string): Record<string, unknown> {
  const update = writeArgs(requests).update as Record<string, Record<string, unknown>>;
  return update[id] as Record<string, unknown>;
}

/** The invitation the account is on exactly once, under the key `att-9f`. */
const INVITED = only("ev-invited");

describe("calendar_respond — the one status it writes", () => {
  it("patches the account's own participant and nothing else", async () => {
    const { context, requests } = fakeTransport([INVITED, identities, eventSet]);

    await calendarRespond.run({ eventIds: ["ev-invited"], status: "accepted" }, context);

    expect(patchOf(requests, "ev-invited")).toEqual({
      "participants/att-9f/participationStatus": "accepted",
    });
  });

  it("never writes the participants map whole, which would erase the other guests", async () => {
    const { context, requests } = fakeTransport([INVITED, identities, eventSet]);

    await calendarRespond.run({ eventIds: ["ev-invited"], status: "declined" }, context);
    const paths = Object.keys(patchOf(requests, "ev-invited"));

    expect(paths).not.toContain("participants");
    for (const path of paths) expect(path.startsWith("participants/att-9f/")).toBe(true);
  });

  it("keeps a comment under the same key as the status it explains", async () => {
    const { context, requests } = fakeTransport([INVITED, identities, eventSet]);

    await calendarRespond.run(
      { eventIds: ["ev-invited"], status: "declined", comment: "En congés." },
      context,
    );

    expect(patchOf(requests, "ev-invited")).toEqual({
      "participants/att-9f/participationStatus": "declined",
      "participants/att-9f/participationComment": "En congés.",
    });
  });

  it("names who answered and to whom, rather than leaving both to be trusted", async () => {
    const { context } = fakeTransport([INVITED, identities, eventSet]);

    const result = await calendarRespond.run(
      { eventIds: ["ev-invited"], status: "tentative" },
      context,
    );

    expect(result.text).toContain("answered as bryan@example.com");
    expect(result.text).toContain("organiser claire@example.org");
  });

  it("renders a refusal the server made by id, without a global success", async () => {
    const refused = { notUpdated: { "ev-invited": { type: "forbidden" } } };
    const { context } = fakeTransport([INVITED, identities, refused]);

    const result = await calendarRespond.run(
      { eventIds: ["ev-invited"], status: "accepted" },
      context,
    );

    expect(result.text).toContain("No event was marked accepted");
    expect(result.text).toContain("forbidden");
  });

  it("accounts for an id the read never returned", async () => {
    const { context, requests } = fakeTransport([only("ev-invited"), identities, eventSet]);

    const result = await calendarRespond.run(
      { eventIds: ["ev-invited", "ev-gone"], status: "accepted" },
      context,
    );

    expect(Object.keys(writeArgs(requests).update as object)).toEqual(["ev-invited"]);
    expect(result.text).toContain("Not found: ev-gone");
  });
});

describe("calendar_respond — mailing the organiser", () => {
  it("asks the server to send by default, and says only that it asked", async () => {
    const { context, requests } = fakeTransport([INVITED, identities, eventSet]);

    const result = await calendarRespond.run(
      { eventIds: ["ev-invited"], status: "accepted" },
      context,
    );

    expect(writeArgs(requests).sendSchedulingMessages).toBe(true);
    expect(result.text).toContain("asked to mail");
    expect(result.text).not.toMatch(/(answer|reply) (was )?sent/i);
  });

  it("stays local when notify is refused, and says the organiser was not told", async () => {
    const { context, requests } = fakeTransport([INVITED, identities, eventSet]);

    const result = await calendarRespond.run(
      { eventIds: ["ev-invited"], status: "accepted", notify: false },
      context,
    );

    expect(writeArgs(requests).sendSchedulingMessages).toBe(false);
    expect(result.text).toContain("No reply was mailed");
  });

  it("classifies on notify alone, so a local answer is a draft", () => {
    expect(calendarRespond.classify({ eventIds: ["ev-invited"], status: "accepted" })).toBe("send");
    expect(
      calendarRespond.classify({ eventIds: ["ev-invited"], status: "accepted", notify: true }),
    ).toBe("send");
    expect(
      calendarRespond.classify({ eventIds: ["ev-invited"], status: "accepted", notify: false }),
    ).toBe("draft");
  });

  it("warns when the event names no organiser for the reply to reach", async () => {
    const orphan: GetResponse<CalendarEvent> = {
      ...INVITED,
      list: INVITED.list.map((event) => {
        const { organizerCalendarAddress: _dropped, ...rest } = event;
        return rest;
      }),
    };
    const { context } = fakeTransport([orphan, identities, eventSet]);

    const result = await calendarRespond.run(
      { eventIds: ["ev-invited"], status: "accepted" },
      context,
    );

    expect(result.text).toContain("names no organiser");
  });
});

describe("calendar_respond — the key it will not guess", () => {
  it("refuses when no address of the account is on the event", async () => {
    const { context, requests } = fakeTransport([only("ev-simple"), identities]);

    const result = await calendarRespond.run(
      { eventIds: ["ev-simple"], status: "accepted" },
      context,
    );

    expect(result.text).toContain("none of the participants of ev-simple");
    // Named as the server spells them: the local part is case-sensitive, and a
    // refusal that folded it would point at an address nobody would recognise.
    expect(result.text).toContain("Bryan@Example.COM");
    expect(named(requests, "CalendarEvent/set")).toHaveLength(0);
  });

  it("refuses when two addresses of the account are, and names them both", async () => {
    const { context, requests } = fakeTransport([only("ev-both-identities"), identities]);

    const result = await calendarRespond.run(
      { eventIds: ["ev-both-identities"], status: "accepted" },
      context,
    );

    expect(result.text).toContain("bryan@example.com");
    expect(result.text).toContain("bryan.berger@example.com");
    expect(named(requests, "CalendarEvent/set")).toHaveLength(0);
  });

  it("refuses an isolated occurrence by naming the event that carries the rule", async () => {
    const { context, requests } = fakeTransport([only("ev-series_20260914T093000")]);

    const result = await calendarRespond.run(
      { eventIds: ["ev-series_20260914T093000"], status: "declined" },
      context,
    );

    expect(result.text).toContain("occurrence of ev-series");
    expect(named(requests, "CalendarEvent/set")).toHaveLength(0);
  });

  it("refuses the whole call rather than answering the invitations it could", async () => {
    const { context, requests } = fakeTransport([only("ev-invited", "ev-simple"), identities]);

    const result = await calendarRespond.run(
      { eventIds: ["ev-invited", "ev-simple"], status: "accepted" },
      context,
    );

    expect(result.text).toContain("ev-simple");
    expect(named(requests, "CalendarEvent/set")).toHaveLength(0);
  });

  it("refuses a batch past the hard ceiling before reading anything", async () => {
    const { context, requests } = fakeTransport([]);
    const ids = Array.from({ length: 51 }, (_, index) => `ev-${index}`);

    const result = await calendarRespond.run({ eventIds: ids, status: "accepted" }, context);

    expect(result.text).toContain("batches of 50");
    expect(calls(requests)).toEqual([]);
  });
});

describe("calendar_respond — the perimeter and the question", () => {
  it("reads nothing at all when the perimeter is open", async () => {
    const { context, requests } = fakeTransport([]);

    const refusal = await calendarRespond.precheck?.(
      { eventIds: ["ev-invited"], status: "accepted" },
      context,
    );

    expect(refusal).toBeUndefined();
    expect(calls(requests)).toEqual([]);
  });

  it("refuses an organiser outside the perimeter, before any question is asked", async () => {
    const scope = restrictTo({ fromContacts: ["paul@example.org"], allow: [] });
    const { context, requests } = fakeTransport([INVITED, identities], { recipients: scope });

    const refusal = await calendarRespond.precheck?.(
      { eventIds: ["ev-invited"], status: "accepted" },
      context,
    );

    expect(refusal).toContain("outside the recipient perimeter");
    expect(named(requests, "CalendarEvent/set")).toHaveLength(0);
  });

  it("lets an organiser inside the perimeter through", async () => {
    const scope = restrictTo({ fromContacts: ["claire@example.org"], allow: [] });
    const { context } = fakeTransport([INVITED, identities], { recipients: scope });

    const refusal = await calendarRespond.precheck?.(
      { eventIds: ["ev-invited"], status: "accepted" },
      context,
    );

    expect(refusal).toBeUndefined();
  });

  it("lets a failed read fall through to run rather than refusing on a transport error", async () => {
    const scope = restrictTo({ fromContacts: ["paul@example.org"], allow: [] });
    // The transport answers `{}`, so the read throws inside the hook.
    const { context } = fakeTransport([], { recipients: scope });

    const refusal = await calendarRespond.precheck?.(
      { eventIds: ["ev-invited"], status: "accepted" },
      context,
    );

    expect(refusal).toBeUndefined();
  });

  it("asks about volume past the threshold, and stays quiet under it", async () => {
    const { context } = fakeTransport([], { bulkConfirmAbove: 3 });
    const ids = (count: number) => Array.from({ length: count }, (_, index) => `ev-${index}`);

    const under = await calendarRespond.confirmWhen?.(
      { eventIds: ids(3), status: "accepted" },
      context,
    );
    const over = await calendarRespond.confirmWhen?.(
      { eventIds: ids(4), status: "accepted" },
      context,
    );

    expect(under).toBeUndefined();
    expect(over).toContain("4 invitations");
  });

  it("names the event, the organiser and the status before it is confirmed", async () => {
    const { context } = fakeTransport([INVITED, identities]);

    const summary = await calendarRespond.summarize(
      { eventIds: ["ev-invited"], status: "declined" },
      context,
    );

    expect(summary).toContain("Revue de contrat");
    expect(summary).toContain("organiser claire@example.org");
    expect(summary).toContain("as declined");
    expect(summary).toContain("mail the answer to the organiser");
  });

  it("degrades to a count rather than failing on a read it only needed for words", async () => {
    const { context } = fakeTransport([]);

    const summary = await calendarRespond.summarize(
      { eventIds: ["ev-invited"], status: "accepted", notify: false },
      context,
    );

    expect(summary).toContain("Answer 1 invitation");
    expect(summary).toContain("not told");
  });
});
