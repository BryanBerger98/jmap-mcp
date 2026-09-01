import { describe, expect, it } from "vitest";
import {
  bareAddress,
  buildEventCreation,
  buildEventPatch,
  buildParticipants,
  defaultCalendar,
  describeEventOutcome,
  describeWhen,
  type EventEdit,
  matchingParticipantKey,
  refuseIsolatedOccurrence,
  refusePrefixCollision,
  resolveParticipantIdentities,
  seriesNote,
} from "../../src/domains/calendar/edit.js";
import type {
  Calendar,
  CalendarEvent,
  ParticipantIdentity,
} from "../../src/jmap/types/calendars.js";
import type { GetResponse, SetResponse } from "../../src/jmap/types/core.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const events = loadFixture<GetResponse<CalendarEvent>>("calendar-event-writable.json");
const identityResponse = loadFixture<GetResponse<ParticipantIdentity>>(
  "participant-identity-get.json",
);
const setResponse = loadFixture<SetResponse<unknown>>("calendar-event-set.json");

const byId = (id: string): CalendarEvent =>
  events.list.find((event) => event.id === id) as CalendarEvent;

/** Title, description, hour, place, no participant. */
const simple = byId("ev-simple");
/** Carries a weekly rule: a correction here reaches every occurrence. */
const series = byId("ev-series");
/** Organized by somebody else, with one address of the account among the guests. */
const invited = byId("ev-invited");
/** Two addresses of the account are invited: nothing here says which is answering. */
const ambiguous = byId("ev-both-identities");
/** A synthetic id the server expands, pointing back at `ev-series`. */
const occurrence = byId("ev-series_20260914T093000");

const identities = identityResponse.list;

describe("buildEventPatch — what nobody names stays untouched", () => {
  it("corrects an hour with the three properties that hour needs and no other", () => {
    const patch = buildEventPatch(simple, {
      start: "2026-09-10T16:00:00",
      duration: "PT1H",
      timeZone: "Europe/Paris",
    });

    expect(patch).toEqual({
      start: "2026-09-10T16:00:00",
      duration: "PT1H",
      timeZone: "Europe/Paris",
    });
  });

  it("leaves the participants, the description and the recurrence out of that patch", () => {
    const patch = buildEventPatch(series, {
      start: "2026-09-07T10:00:00",
      timeZone: "Europe/Paris",
    });
    const keys = Object.keys(patch).join(" ");

    for (const untouched of ["participants", "description", "recurrenceRules", "locations"]) {
      expect(keys).not.toContain(untouched);
    }
  });

  it("never writes utcStart, which the draft refuses next to start", () => {
    const patch = buildEventPatch(simple, { start: "2026-09-10T16:00:00" });

    expect(Object.keys(patch).join(" ")).not.toContain("utc");
  });

  it("points into the existing location rather than replacing the map", () => {
    const patch = buildEventPatch(simple, { location: "Salle Sud" });

    expect(patch).toEqual({ "locations/l1/name": "Salle Sud" });
  });

  it("writes the whole map when the event carries no location", () => {
    const patch = buildEventPatch(series, { location: "Visio" });

    expect(patch).toEqual({ locations: { l1: { name: "Visio" } } });
  });
});

describe("buildEventPatch — participants", () => {
  it("adds a guest under a free key, leaving the taken ones alone", () => {
    const patch = buildEventPatch(invited, { participantsAdd: ["noor@example.org"] });

    const [key] = Object.keys(patch);
    expect(Object.keys(patch)).toHaveLength(1);
    expect(key).toMatch(/^participants\/p\d+$/);
    for (const held of ["org", "att-9f", "att-c3"]) {
      expect(key).not.toBe(`participants/${held}`);
    }
  });

  it("removes a guest by address, folding case and the mailto scheme", () => {
    const patch = buildEventPatch(invited, { participantsRemove: ["MAILTO:Paul@Example.ORG"] });

    expect(patch).toEqual({ "participants/att-c3": null });
  });

  it("writes the whole map when the event carries no participant at all", () => {
    const patch = buildEventPatch(simple, { participantsAdd: ["noor@example.org"] });

    expect(Object.keys(patch)).toEqual(["participants"]);
    expect(Object.values(patch.participants as Record<string, unknown>)).toHaveLength(1);
  });

  it("emits nothing for an event with no participants when asked to remove one", () => {
    expect(buildEventPatch(simple, { participantsRemove: ["paul@example.org"] })).toEqual({});
  });

  it("never emits two patches where one is the prefix of the other", () => {
    const patch = buildEventPatch(invited, {
      title: "Revue de contrat — reportée",
      participantsAdd: ["noor@example.org"],
      participantsRemove: ["paul@example.org"],
    });

    const keys = Object.keys(patch);
    for (const key of keys) {
      expect(keys.some((other) => other.startsWith(`${key}/`))).toBe(false);
    }
  });
});

describe("refusePrefixCollision", () => {
  it("refuses a family replaced and amended in the same patch, before any request", () => {
    const contradictory = {
      participants: { p1: { calendarAddress: "mailto:noor@example.org" } },
      "participants/att-c3/roles": { attendee: true },
    };

    expect(() => refusePrefixCollision(contradictory)).toThrow(/prefix of another/);
  });

  it("says nothing about two pointers that merely share a parent", () => {
    expect(() =>
      refusePrefixCollision({ "participants/p1": null, "participants/p2": null }),
    ).not.toThrow();
  });
});

describe("buildEventCreation", () => {
  it("never carries isDraft, whatever is asked of it", () => {
    const created = buildEventCreation({ title: "Atelier" }, ["cal-1"]);

    expect(created).not.toHaveProperty("isDraft");
    expect(Object.keys(created).join(" ")).not.toContain("isDraft");
  });

  it("files the event in the calendars it was given", () => {
    const created = buildEventCreation({ title: "Atelier" }, ["cal-1", "cal-2"]);

    expect(created.calendarIds).toEqual({ "cal-1": true, "cal-2": true });
  });

  it("writes each named field once and leaves the rest out of the object", () => {
    const edit: EventEdit = {
      title: "Atelier",
      start: "2026-09-15T09:00:00",
      duration: "PT2H",
      timeZone: "Europe/Paris",
    };
    const created = buildEventCreation(edit, ["cal-1"]);

    expect(created.title).toBe("Atelier");
    expect(created.timeZone).toBe("Europe/Paris");
    expect(created.description).toBeUndefined();
    expect(created.participants).toBeUndefined();
    expect(created).not.toHaveProperty("utcStart");
  });

  it("states the organizer when somebody is invited, so the server may schedule", () => {
    const created = buildEventCreation(
      { title: "Atelier", participantsAdd: ["noor@example.org"] },
      ["cal-1"],
      { calendarAddress: "Bryan@Example.COM", name: "Bryan Berger" },
    );

    // The case survives: the local part of an address is case-sensitive, and
    // this is the spelling the server itself handed back as an identity.
    expect(created.organizerCalendarAddress).toBe("mailto:Bryan@Example.COM");
    expect(created.participants?.p1?.roles?.owner).toBe(true);
    expect(Object.values(created.participants ?? {})).toHaveLength(2);
  });

  it("keeps the guests when no identity of the account could be settled", () => {
    const created = buildEventCreation(
      { title: "Atelier", participantsAdd: ["noor@example.org"] },
      ["cal-1"],
    );

    // The event is local and correctable without an organizer; a guest dropped
    // from the object is gone, with nothing on the event to say they were asked
    // for.
    expect(created.organizerCalendarAddress).toBeUndefined();
    const participants = Object.values(created.participants ?? {});
    expect(participants).toHaveLength(1);
    expect(participants[0]?.calendarAddress).toBe("mailto:noor@example.org");
    // No owner entry either: nothing established who would own the event.
    for (const participant of participants) expect(participant.roles?.owner).toBeUndefined();
  });

  it("states no organizer on an event nobody is invited to", () => {
    const created = buildEventCreation({ title: "Atelier" }, ["cal-1"], {
      calendarAddress: "bryan@example.com",
    });

    expect(created.organizerCalendarAddress).toBeUndefined();
  });
});

describe("buildParticipants", () => {
  it("turns an address into an invitation, not into an attendance", () => {
    const built = buildParticipants(["Noor@Example.ORG"]);
    const participant = Object.values(built)[0];

    expect(participant?.calendarAddress).toBe("mailto:Noor@Example.ORG");
    expect(participant?.participationStatus).toBe("needs-action");
    expect(participant?.expectReply).toBe(true);
  });

  it("never lands on a key already taken", () => {
    const built = buildParticipants(["a@example.org", "b@example.org"], new Set(["p1"]));

    expect(Object.keys(built)).toEqual(["p2", "p3"]);
  });
});

describe("matchingParticipantKey", () => {
  it("recognizes the account across case and the mailto scheme", () => {
    // The identity is spelled `mailto:Bryan@Example.COM`, the invitation
    // `mailto:bryan@example.com`: two people wrote them, neither owes the other
    // a spelling.
    expect(matchingParticipantKey(invited, identities).key).toBe("att-9f");
  });

  it("refuses rather than guessing when no participant is an address of the account", () => {
    const match = matchingParticipantKey(simple, identities);

    expect(match.key).toBeUndefined();
    expect(match.refusal).toContain("none of the participants");
    // The refusal names what the account does schedule as, so the reader has
    // something to check their event against.
    expect(match.refusal).toContain("Bryan@Example.COM");
  });

  it("refuses rather than choosing when two addresses of the account are invited", () => {
    const match = matchingParticipantKey(ambiguous, identities);

    expect(match.key).toBeUndefined();
    expect(match.refusal).toContain("2 participants");
    expect(match.refusal).toContain("bryan.berger@example.com");
  });
});

describe("refuseIsolatedOccurrence", () => {
  it("refuses an expanded occurrence by naming the event that carries the rule", () => {
    const refusal = refuseIsolatedOccurrence([occurrence]);

    expect(refusal).toContain("ev-series_20260914T093000");
    expect(refusal).toContain("occurrence of ev-series");
  });

  it("says nothing about a base event that merely repeats", () => {
    expect(refuseIsolatedOccurrence([simple, series, invited])).toBeUndefined();
  });
});

describe("describeEventOutcome", () => {
  it("never claims a success the server did not grant", () => {
    const rendered = describeEventOutcome(setResponse, ["ev-simple", "ev-series"], "updated");

    expect(rendered).toContain("1 of 2 events updated");
    expect(rendered).toContain("may not write to this calendar");
    expect(rendered.startsWith("2 events updated")).toBe(false);
  });

  it("reads the destroy half when asked for it", () => {
    const rendered = describeEventOutcome(
      setResponse,
      ["ev-invited", "ev-both-identities"],
      "destroyed",
      "destroyed",
    );

    expect(rendered).toContain("1 of 2 events destroyed");
    expect(rendered).toContain("notFound");
  });
});

describe("seriesNote — one sentence, each tool's own verb", () => {
  // The three writing tools rendered this themselves until the copies drifted
  // apart in wording. Both sentences are pinned whole here: the shared helper is
  // the only thing standing between them and a third wording nobody chose.
  it("spells a correction reaching the series exactly as calendar_write says it", () => {
    expect(seriesNote([series], "this write reaches the whole series")).toBe(
      "ev-series is a recurring event: this write reaches the whole series, every occurrence " +
        "included, not one date of it.",
    );
  });

  it("spells a deletion taking the series exactly as calendar_delete says it", () => {
    expect(seriesNote([series], "the whole series disappears")).toBe(
      "ev-series is a recurring event: the whole series disappears, every occurrence included, " +
        "not one date of it.",
    );
  });

  it("names every rule-bearing event and agrees the verb with them", () => {
    const note = seriesNote([simple, series, { ...series, id: "ev-other" }], "it goes");

    expect(note).toContain("ev-series, ev-other are recurring events");
    expect(note).not.toContain("ev-simple");
  });

  it("says nothing at all when no event carries a rule", () => {
    expect(seriesNote([simple, invited], "it goes")).toBeUndefined();
  });
});

describe("describeWhen", () => {
  it("states the hour in the event's own zone, never converted", () => {
    expect(describeWhen(simple)).toBe(`${simple.start} ${simple.timeZone}`);
  });

  it("says so rather than inventing an hour for an event without one", () => {
    expect(describeWhen({ id: "ev-void" })).toBe("no start");
  });

  it("leaves the hour bare when the event names no zone", () => {
    expect(describeWhen({ id: "ev-floating", start: "2026-09-10T16:00:00" })).toBe(
      "2026-09-10T16:00:00",
    );
  });
});

describe("bareAddress", () => {
  it("strips the scheme whichever case it was written in", () => {
    expect(bareAddress("MAILTO:Paul@Example.ORG")).toBe("Paul@Example.ORG");
  });

  it("never folds the address it hands back, the local part being case-sensitive", () => {
    expect(bareAddress("  Bryan@Example.COM  ")).toBe("Bryan@Example.COM");
  });
});

describe("defaultCalendar", () => {
  const personal: Calendar = { id: "cal-1", name: "Personnel", isDefault: true };
  const work: Calendar = { id: "cal-2", name: "Travail" };

  it("takes the calendar the server marked", () => {
    expect(defaultCalendar([work, personal])?.id).toBe("cal-1");
  });

  it("takes the only calendar of an account that has one", () => {
    expect(defaultCalendar([work])?.id).toBe("cal-2");
  });

  it("returns nothing rather than picking among several unmarked calendars", () => {
    expect(defaultCalendar([work, { id: "cal-3", name: "Famille" }])).toBeUndefined();
  });
});

describe("resolveParticipantIdentities", () => {
  it("asks for every identity, and asks once per invocation", async () => {
    const { context, requests } = fakeTransport([identityResponse, identityResponse]);

    const first = await resolveParticipantIdentities(context);
    const second = await resolveParticipantIdentities(context);

    expect(first).toBe(second);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.methodCalls[0]?.[0]).toBe("ParticipantIdentity/get");
    expect(requests[0]?.methodCalls[0]?.[1]?.ids).toBeNull();
  });
});
