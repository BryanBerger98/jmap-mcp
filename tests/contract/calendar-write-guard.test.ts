import { isInputRequiredResult, type McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { OPEN_SCOPE, type RecipientScope, restrictTo } from "../../src/config/recipients.js";
import { calendarWritingDomain } from "../../src/domains/calendar/index.js";
import type { JmapClient } from "../../src/jmap/client.js";
import type { JmapSession } from "../../src/jmap/session.js";
import type {
  Calendar,
  CalendarEvent,
  ParticipantIdentity,
} from "../../src/jmap/types/calendars.js";
import type { GetResponse, Id, JmapRequest } from "../../src/jmap/types/core.js";
import { CAPABILITY_CALENDARS, CAPABILITY_MAIL } from "../../src/jmap/types/core.js";
import { compose } from "../../src/registry/compose.js";
import type { ToolDefinition } from "../../src/registry/define-tool.js";
import { MAX_IDS_PER_CALL } from "../../src/shared/batch.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

/**
 * The invariant this file exists for: an event is written only on arguments the
 * caller gave, and no invitation mail is ever requested without a confirmation
 * that named its recipients first.
 *
 * The load-bearing assertion is the last one of `an emitted write`:
 * `sendSchedulingMessages` is on every `CalendarEvent/set` this surface sends,
 * including — especially — the ones where it is false. A server default is not a
 * guarantee, and an absent argument shows up on no unit test.
 *
 * Written over `calendarWritingDomain.tools`, so a tool added to the manifest is
 * held to the same guarantees the day it lands.
 */

const calendars = loadFixture<GetResponse<Calendar>>("calendar-get.json");
const events = loadFixture<GetResponse<CalendarEvent>>("calendar-event-writable.json");
const identities = loadFixture<GetResponse<ParticipantIdentity>>("participant-identity-get.json");
const eventSet = loadFixture<Record<string, unknown>>("calendar-event-set.json");

/**
 * Every key that would let a call name a set of events instead of listing them.
 *
 * A destructive or bulk write that took a filter would act on whatever the
 * filter matched at that instant, which is never what was shown to the caller.
 */
const CRITERIA = ["query", "search", "text", "filter", "before", "after", "cursor", "position"];

/** The read fixture narrowed to the ids one case is about. */
function only(...ids: Id[]): GetResponse<CalendarEvent> {
  return { ...events, list: events.list.filter((event) => ids.includes(event.id)) };
}

type Handler = (
  args: unknown,
  ctx: { mcpReq: { inputResponses?: Record<string, unknown>; envelope?: Record<string, unknown> } },
) => Promise<unknown>;

const CONFIRMED = {
  mcpReq: { inputResponses: { confirm: { action: "accept", content: { confirm: true } } } },
};
const DECLINED = {
  mcpReq: { inputResponses: { confirm: { action: "accept", content: { confirm: false } } } },
};
const UNANSWERED = { mcpReq: {} };

function writingSurface(
  responses: unknown[],
  capabilities: Record<string, unknown> | null,
  options: { bulkConfirmAbove?: number; recipients?: RecipientScope } = {},
) {
  const { context, requests } = fakeTransport(
    responses,
    options.recipients ?? OPEN_SCOPE,
    options.bulkConfirmAbove,
  );
  const handlers = new Map<string, Handler>();

  compose({
    server: {
      registerTool(name: string, _config: unknown, cb: Handler) {
        handlers.set(name, cb);
      },
      ...(capabilities === null ? {} : { server: { getClientCapabilities: () => capabilities } }),
    } as unknown as McpServer,
    domains: [calendarWritingDomain],
    session: advertisingCalendars(context.session),
    client: context.client,
    policy: DEFAULT_POLICY,
    recipients: options.recipients ?? OPEN_SCOPE,
    ...(options.bulkConfirmAbove === undefined
      ? {}
      : { bulkConfirmAbove: options.bulkConfirmAbove }),
  });

  return {
    handlers,
    requests,
    write: handlers.get("calendar_write") as Handler,
    respond: handlers.get("calendar_respond") as Handler,
  };
}

/**
 * The session fixture, plus the calendars capability it does not advertise.
 *
 * The account it stands for is a mail account; gating is tested on its own
 * below, and a manifest registering nothing here would make every assertion of
 * this file pass on an empty handler map.
 */
function advertisingCalendars(session: JmapSession): JmapSession {
  return Object.assign(Object.create(session) as JmapSession, {
    has: (uri: string) => uri === CAPABILITY_CALENDARS || session.has(uri),
  });
}

function fakeServer(registered: string[]): McpServer {
  return {
    registerTool(name: string) {
      registered.push(name);
    },
  } as unknown as McpServer;
}

function sessionWith(capabilities: readonly string[]): JmapSession {
  return { has: (uri: string) => capabilities.includes(uri) } as unknown as JmapSession;
}

function methodsOf(requests: JmapRequest[]): string[] {
  return requests.flatMap((request) => request.methodCalls.map(([name]) => name));
}

function writesIn(requests: JmapRequest[]): string[] {
  return methodsOf(requests).filter((method) => method.endsWith("/set"));
}

function eventSets(requests: JmapRequest[]): Record<string, unknown>[] {
  return requests.flatMap((request) =>
    request.methodCalls
      .filter(([name]) => name === "CalendarEvent/set")
      .map(([, args]) => args as Record<string, unknown>),
  );
}

function textOf(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((part) => part.text ?? "").join("");
}

/** The whole elicitation payload, message included, whatever shape it carries. */
function questionOf(result: unknown): string {
  return JSON.stringify(result);
}

function keysOf(tool: ToolDefinition): string[] {
  return Object.keys((tool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>).shape);
}

const TOOLS = calendarWritingDomain.tools.map((tool) => [tool.name, tool] as const);

const CREATE = { title: "Point budget", start: "2026-09-10T14:00", duration: "PT1H" };
const GUESTS = ["noor@example.org", "paul@example.org"];

describe("the writing manifest", () => {
  it.each(TOOLS)("%s carries no search criterion, only ids and fields", (_name, tool) => {
    expect(keysOf(tool).filter((key) => CRITERIA.includes(key))).toEqual([]);
  });

  it.each(TOOLS)("%s shares the calendar_ prefix", (name) => {
    expect(name.startsWith("calendar_")).toBe(true);
  });

  it.each(TOOLS)("%s declares every class it can reach", (_name, tool) => {
    // A tool reaching a class it did not declare would be registered on a policy
    // that denies that class, and refused only once the call was made.
    const reachable = [{}, { notify: true }, { notify: false }].map((input) =>
      tool.classify(input as never),
    );

    for (const operation of reachable) {
      expect(tool.classes).toContain(operation);
    }
  });

  it("reads the class off notify and off nothing else", () => {
    const tool = calendarWritingDomain.tools.find((each) => each.name === "calendar_write");

    expect(tool?.classes).toEqual(["draft", "send"]);
    expect(tool?.classify({ ...CREATE } as never)).toBe("draft");
    expect(tool?.classify({ ...CREATE, notify: false } as never)).toBe("draft");
    // Fifty guests written onto the event still send nothing on their own.
    expect(tool?.classify({ ...CREATE, participantsAdd: GUESTS } as never)).toBe("draft");
    expect(tool?.classify({ ...CREATE, notify: true } as never)).toBe("send");
  });
});

describe("gating", () => {
  it("registers the writing tools on a session advertising calendars", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: [calendarWritingDomain],
      session: sessionWith([CAPABILITY_CALENDARS]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual(calendarWritingDomain.tools.map((tool) => tool.name));
    expect(report.skipped).toEqual([]);
  });

  it("registers nothing without the capability, and names the one that is missing", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: [calendarWritingDomain],
      session: sessionWith([CAPABILITY_MAIL]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual([]);
    expect(report.skipped).toEqual([
      { domain: "calendar-writing", missing: [CAPABILITY_CALENDARS] },
    ]);
  });
});

describe("a write that mails its participants", () => {
  const notifying = { ...CREATE, participantsAdd: GUESTS, notify: true };

  it("is refused outright on a client that cannot be asked", async () => {
    const { write, requests } = writingSurface([calendars], { roots: {} });

    const result = await write(notifying, UNANSWERED);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("elicitation");
    // A read may precede the refusal — `precheck` runs before the elicitation
    // check by design, so a doomed call is never put to the user — but nothing
    // is written, and no scheduling mail can have been asked for.
    expect(writesIn(requests)).toEqual([]);
  });

  it("puts the call to the user, naming the recipients and their number", async () => {
    const { write, requests } = writingSurface([calendars], { elicitation: {} });

    const result = await write(notifying, UNANSWERED);

    expect(isInputRequiredResult(result)).toBe(true);
    const question = questionOf(result);
    expect(question).toContain("2");
    for (const guest of GUESTS) expect(question).toContain(guest);
    expect(writesIn(requests)).toEqual([]);
  });

  it("writes nothing when the confirmation comes back false", async () => {
    const { write, requests } = writingSurface([calendars], { elicitation: {} });

    await write(notifying, DECLINED);

    expect(writesIn(requests)).toEqual([]);
  });

  it("asks the server to schedule only once the confirmation is granted", async () => {
    const { write, requests } = writingSurface([calendars, identities, eventSet], {
      elicitation: {},
    });

    const result = await write(notifying, CONFIRMED);

    expect(eventSets(requests)).toHaveLength(1);
    expect(eventSets(requests)[0]?.sendSchedulingMessages).toBe(true);
    // What was asked, never what the server did with it.
    expect(textOf(result)).not.toMatch(/invitation (was )?sent/i);
  });
});

describe("a write that mails nobody", () => {
  it("runs without a question, and states that nothing was scheduled", async () => {
    const { write, requests } = writingSurface([calendars, eventSet], { elicitation: {} });

    const result = await write(CREATE, UNANSWERED);

    expect(isInputRequiredResult(result)).toBe(false);
    expect(eventSets(requests)[0]?.sendSchedulingMessages).toBe(false);
  });
});

describe("an emitted write", () => {
  /**
   * Every path this surface can take to a `CalendarEvent/set`, run for the one
   * assertion below. Validated by mutation: dropping `sendSchedulingMessages`
   * from either call site of `write.ts` turns this red.
   */
  const PATHS: { name: string; input: Record<string, unknown>; responses: unknown[] }[] = [
    { name: "a creation", input: CREATE, responses: [calendars, eventSet] },
    {
      name: "a creation that invites",
      input: { ...CREATE, participantsAdd: GUESTS, notify: true },
      responses: [calendars, identities, eventSet],
    },
    {
      name: "a correction",
      input: { eventIds: ["ev-simple"], start: "2026-09-10T16:00" },
      responses: [only("ev-simple"), calendars, eventSet],
    },
    {
      name: "a correction that notifies",
      input: { eventIds: ["ev-invited"], status: "cancelled", notify: true },
      responses: [only("ev-invited"), calendars, eventSet],
    },
  ];

  it.each(PATHS)(
    "$name carries sendSchedulingMessages explicitly",
    async ({ input, responses }) => {
      const { write, requests } = writingSurface(responses, { elicitation: {} });

      await write(input, CONFIRMED);

      const emitted = eventSets(requests);
      // Vacuously true if nothing was written, so the count is asserted first.
      expect(emitted).toHaveLength(1);
      expect(Object.hasOwn(emitted[0] as object, "sendSchedulingMessages")).toBe(true);
      expect(typeof emitted[0]?.sendSchedulingMessages).toBe("boolean");
    },
  );

  it.each(PATHS)("$name never travels with a destruction", async ({ input, responses }) => {
    const { write, requests } = writingSurface(responses, { elicitation: {} });

    await write(input, CONFIRMED);

    for (const args of eventSets(requests)) {
      expect(args.destroy).toBeUndefined();
    }
  });
});

describe("an answer to an invitation", () => {
  /**
   * The invitation fixture holds three participants: the organiser under `org`,
   * this account under `att-9f`, and a third guest under `att-c3`. The key is
   * asserted literally, and that is the point — matching on the first key of the
   * map instead of on the account's identities would answer as the organiser and
   * turn every assertion below red.
   */
  const ACCOUNT_KEY = "att-9f";
  const ANSWER = { eventIds: ["ev-invited"], status: "accepted" };

  /** Every patch object this surface sent, whichever event it was aimed at. */
  function patches(requests: JmapRequest[]): Record<string, unknown>[] {
    return eventSets(requests).flatMap((args) =>
      Object.values((args.update ?? {}) as Record<string, Record<string, unknown>>),
    );
  }

  it("writes under the account's own participant key and nowhere else", async () => {
    const { respond, requests } = writingSurface([only("ev-invited"), identities, eventSet], {
      elicitation: {},
    });

    await respond({ ...ANSWER, comment: "Je serai là." }, CONFIRMED);

    const emitted = patches(requests);
    // Vacuously true if nothing was written, so the count is asserted first.
    expect(emitted).toHaveLength(1);
    for (const path of Object.keys(emitted[0] as object)) {
      expect(path.startsWith(`participants/${ACCOUNT_KEY}/`)).toBe(true);
    }
  });

  it("never carries the participants map whole, which would erase the other guests", async () => {
    const { respond, requests } = writingSurface([only("ev-invited"), identities, eventSet], {
      elicitation: {},
    });

    await respond(ANSWER, CONFIRMED);

    for (const patch of patches(requests)) {
      expect(Object.hasOwn(patch, "participants")).toBe(false);
      // Nor any pointer at another participant: `att-c3` answers for themselves.
      expect(Object.keys(patch).some((path) => path.startsWith("participants/att-c3"))).toBe(false);
    }
  });

  it("carries sendSchedulingMessages explicitly, as every write of this surface does", async () => {
    const { respond, requests } = writingSurface([only("ev-invited"), identities, eventSet], {
      elicitation: {},
    });

    await respond(ANSWER, CONFIRMED);

    const emitted = eventSets(requests);
    expect(emitted).toHaveLength(1);
    expect(Object.hasOwn(emitted[0] as object, "sendSchedulingMessages")).toBe(true);
    expect(emitted[0]?.sendSchedulingMessages).toBe(true);
  });

  it("is refused outright on a client that cannot be asked", async () => {
    const { respond, requests } = writingSurface([only("ev-invited"), identities], { roots: {} });

    const result = await respond(ANSWER, UNANSWERED);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("elicitation");
    expect(writesIn(requests)).toEqual([]);
  });

  it("stays a draft, and asks nothing, when the answer is held back", async () => {
    const { respond, requests } = writingSurface([only("ev-invited"), identities, eventSet], {
      elicitation: {},
    });

    const result = await respond({ ...ANSWER, notify: false }, UNANSWERED);

    expect(isInputRequiredResult(result)).toBe(false);
    expect(eventSets(requests)[0]?.sendSchedulingMessages).toBe(false);
  });

  it("refuses an organiser outside the perimeter before the question is asked", async () => {
    const { respond, requests } = writingSurface(
      [only("ev-invited"), identities, eventSet],
      { elicitation: {} },
      { recipients: restrictTo({ fromContacts: ["paul@example.org"], allow: [] }) },
    );

    const result = await respond(ANSWER, UNANSWERED);

    expect(isInputRequiredResult(result)).toBe(false);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("outside the recipient perimeter");
    expect(writesIn(requests)).toEqual([]);
  });
});

describe("the refusals that precede the question", () => {
  it("refuses a batch past the hard ceiling, before any request at all", async () => {
    const { write, requests } = writingSurface([], { elicitation: {} });

    const ids = Array.from({ length: MAX_IDS_PER_CALL + 1 }, (_, index) => `ev-${index}`);
    const result = await write({ eventIds: ids, freeBusyStatus: "busy" }, CONFIRMED);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain(`batches of ${MAX_IDS_PER_CALL}`);
    expect(methodsOf(requests)).toEqual([]);
  });

  it("refuses a participant outside the perimeter before the question is asked", async () => {
    const { write, requests } = writingSurface(
      [calendars, identities, eventSet],
      {
        elicitation: {},
      },
      {
        recipients: restrictTo({ fromContacts: ["paul@example.org"], allow: [] }),
      },
    );

    const result = await write(
      { ...CREATE, participantsAdd: ["stranger@example.net"], notify: true },
      UNANSWERED,
    );

    expect(isInputRequiredResult(result)).toBe(false);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("outside the recipient perimeter");
    expect(methodsOf(requests)).toEqual([]);
  });

  it("refuses an isolated occurrence by naming the event that carries the rule", async () => {
    const { write, requests } = writingSurface([only("ev-series_20260914T093000")], {
      elicitation: {},
    });

    const result = await write(
      { eventIds: ["ev-series_20260914T093000"], start: "2026-09-14T10:00" },
      CONFIRMED,
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("occurrence of ev-series");
    expect(writesIn(requests)).toEqual([]);
  });

  it("refuses a single-event field spread over a batch", async () => {
    const { write, requests } = writingSurface([], { elicitation: {} });

    const ids = Array.from({ length: 30 }, (_, index) => `ev-${index}`);
    const result = await write({ eventIds: ids, start: "2026-09-10T09:00" }, CONFIRMED);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("start");
    expect(methodsOf(requests)).toEqual([]);
  });
});

describe("the volume of a correction", () => {
  const THRESHOLD = 3;

  it("is put to the user past the threshold, without the call becoming a send", async () => {
    const { write, requests } = writingSurface(
      [only("ev-simple"), calendars, eventSet],
      { elicitation: {} },
      { bulkConfirmAbove: THRESHOLD },
    );

    const ids = Array.from({ length: THRESHOLD + 1 }, (_, index) => `ev-${index}`);
    const input = { eventIds: ids, freeBusyStatus: "busy" };
    const result = await write(input, UNANSWERED);

    expect(isInputRequiredResult(result)).toBe(true);
    expect(writesIn(requests)).toEqual([]);
    // The question comes from the volume, never from the class: writing an
    // event stays a draft however many events it touches.
    const tool = calendarWritingDomain.tools.find((each) => each.name === "calendar_write");
    expect(tool?.classify(input as never)).toBe("draft");
  });
});
