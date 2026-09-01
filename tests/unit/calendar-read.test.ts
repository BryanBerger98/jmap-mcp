import { describe, expect, it } from "vitest";
import { calendarRead, MAX_EVENTS } from "../../src/domains/calendar/read.js";
import type {
  Calendar,
  CalendarEvent,
  CalendarEventGetArguments,
} from "../../src/jmap/types/calendars.js";
import type { GetResponse } from "../../src/jmap/types/core.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const calendars = loadFixture<GetResponse<Calendar>>("calendar-get.json");
const details = loadFixture<GetResponse<CalendarEvent>>("calendar-event-detail.json");

/** The two responses one read consumes: the events, then the calendars. */
const answers = (over: Partial<GetResponse<CalendarEvent>> = {}) => [
  { ...details, ...over },
  calendars,
];

const eventArgumentsOf = (requests: { methodCalls: [string, unknown, string][] }[]) =>
  requests[0]?.methodCalls[0]?.[1] as CalendarEventGetArguments;

const ALL_IDS = ["ev-01", "ev-01_20260910T140000", "ev-42"];

describe("calendar_read", () => {
  it("spends one round trip, carrying both calls", async () => {
    const { context, requests } = fakeTransport(answers());

    await calendarRead.run({ ids: ["ev-01"] }, context);

    expect(requests).toHaveLength(1);
    // No back-reference between them: they are independent, and an event that
    // cannot name its calendar is half a read.
    expect(requests[0]?.methodCalls.map(([name]) => name)).toEqual([
      "CalendarEvent/get",
      "Calendar/get",
    ]);
  });

  it("never asks for recurrenceOverrides, which the draft refuses next to utcStart", async () => {
    const { context, requests } = fakeTransport(answers());

    await calendarRead.run({ ids: ["ev-01"] }, context);

    const properties = eventArgumentsOf(requests).properties as string[];
    expect(properties).not.toContain("recurrenceOverrides");
    expect(properties).toContain("utcStart");
    expect(properties).toContain("participants");
  });

  it("sends the timeZone argument only when the call named one", async () => {
    const bare = fakeTransport(answers());
    await calendarRead.run({ ids: ["ev-01"] }, bare.context);
    expect(eventArgumentsOf(bare.requests).timeZone).toBeUndefined();

    const asked = fakeTransport(answers());
    await calendarRead.run({ ids: ["ev-01"], timeZone: "Asia/Tokyo" }, asked.context);
    expect(eventArgumentsOf(asked.requests).timeZone).toBe("Asia/Tokyo");
  });

  it("names the zone once for the whole answer", async () => {
    const { context } = fakeTransport(answers());

    const { text } = await calendarRead.run({ ids: ALL_IDS }, context);

    expect(text.startsWith("Times in Europe/Paris (from the default calendar Personal).")).toBe(
      true,
    );
    // Once, not once per block: three copies of a zone are three ways of not
    // reading it.
    expect(text.match(/Times in/g)).toHaveLength(1);
  });

  it("renders the hours in the zone the call asked for", async () => {
    const { context } = fakeTransport(answers());

    const { text } = await calendarRead.run({ ids: ["ev-01"], timeZone: "Etc/UTC" }, context);

    expect(text).toContain("Times in Etc/UTC (as requested)");
    expect(text).toContain("when: 2026-09-03 12:00 → 13:00");
  });

  it("says a base event repeats, without spelling the rule out", async () => {
    const { context } = fakeTransport(answers({ list: [details.list[0] as CalendarEvent] }));

    const { text } = await calendarRead.run({ ids: ["ev-01"] }, context);

    expect(text).toContain("recurrence: repeats until 2026-12-31");
    expect(text).not.toContain("weekly");
  });

  it("names the base an occurrence came from", async () => {
    const { context } = fakeTransport(answers({ list: [details.list[1] as CalendarEvent] }));

    const { text } = await calendarRead.run({ ids: ["ev-01_20260910T140000"] }, context);

    expect(text).toContain("one occurrence of ev-01");
  });

  it("renders a participant nobody named by their address", async () => {
    const { context } = fakeTransport(answers());

    const { text } = await calendarRead.run({ ids: ["ev-01"] }, context);

    expect(text).toContain("camille@example.org (declined)");
    expect(text).toContain("Ana Silva <ana.silva0@example.org> (needs-action)");
  });

  it("names an id that answered nothing rather than dropping it", async () => {
    const { context } = fakeTransport(answers({ notFound: ["ev-99"] }));

    const { text } = await calendarRead.run({ ids: ["ev-01", "ev-99"] }, context);

    expect(text).toContain("Not found: ev-99");
  });

  it("renders the blocks in the order the call asked for, not the server's", async () => {
    const { context } = fakeTransport(answers());

    const { text } = await calendarRead.run({ ids: ["ev-42", "ev-01"] }, context);

    expect(text.indexOf("ev-42")).toBeLessThan(text.indexOf("ev-01"));
  });

  it("says so rather than rendering nothing when every id missed", async () => {
    const { context } = fakeTransport(answers({ list: [], notFound: [] }));

    const { text } = await calendarRead.run({ ids: ["ev-99"] }, context);

    expect(text).toContain("(no event found)");
  });

  it("refuses an unknown zone before it sends anything", async () => {
    const { context, requests } = fakeTransport(answers());

    const { text } = await calendarRead.run({ ids: ["ev-01"], timeZone: "CEST" }, context);

    expect(text).toContain("Refused");
    expect(requests).toHaveLength(0);
  });

  it("caps a call at twenty ids, through its own schema", () => {
    const tooMany = Array.from({ length: MAX_EVENTS + 1 }, (_, index) => `ev-${index}`);

    expect(calendarRead.inputSchema.safeParse({ ids: tooMany }).success).toBe(false);
    expect(calendarRead.inputSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(calendarRead.inputSchema.safeParse({ ids: ["ev-01"] }).success).toBe(true);
  });
});
