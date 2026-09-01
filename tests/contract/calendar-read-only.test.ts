import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { calendarAvailabilityDomain, calendarDomain } from "../../src/domains/calendar/index.js";
import type { JmapClient } from "../../src/jmap/client.js";
import type { JmapSession } from "../../src/jmap/session.js";
import {
  CAPABILITY_CALENDARS,
  CAPABILITY_MAIL,
  CAPABILITY_PRINCIPALS_AVAILABILITY,
} from "../../src/jmap/types/core.js";
import { compose } from "../../src/registry/compose.js";
import type { ToolDefinition } from "../../src/registry/define-tool.js";
import { fakeTransport } from "../fixtures/client.js";

/**
 * The invariant this file exists for: the calendar surface reads, and only
 * reads. Two claims kept apart, as in the contacts contract — a tool declaring
 * the `read` class and a tool sending nothing but reads on the wire are
 * different assertions, and the second is the one that protects an agenda.
 *
 * The whitelist is written as whole method names rather than as suffixes, which
 * the contacts contract could afford. `Principal/getAvailability` does not end
 * in `/get`, and a suffix rule loose enough to admit it would admit
 * `CalendarEvent/set` on the day somebody adds a write here by mistake.
 */

/** Every read this surface is allowed to emit. Anything else fails the contract. */
const READS = [
  "Calendar/get",
  "Calendar/query",
  "CalendarEvent/get",
  "CalendarEvent/query",
  "Principal/getAvailability",
];

/** A response shaped to satisfy a get, a query and an availability call alike. */
const ANY_RESPONSE = {
  accountId: "acc-1",
  state: "state-1",
  queryState: "query-state-1",
  canCalculateChanges: false,
  position: 0,
  ids: [],
  total: 0,
  list: [],
  notFound: [],
};

const MANIFESTS = [calendarDomain, calendarAvailabilityDomain];
const ALL_TOOLS = MANIFESTS.flatMap((domain) => domain.tools);
const tools = ALL_TOOLS.map((tool) => [tool.name, tool] as const);

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

/**
 * The smallest input the tool's own schema accepts.
 *
 * Derived from the schema, so a tool whose arguments change stays covered. The
 * date candidate is what the contacts version did not need: `calendar_
 * availability` requires two bounds matched against a pattern, and no generic
 * placeholder satisfies it. It sits last so an array or a plain string field
 * still resolves the way it did before.
 */
function minimalArguments(tool: ToolDefinition): Record<string, unknown> {
  const shape = (tool.inputSchema as unknown as { shape: Record<string, ZodType> }).shape;
  const args: Record<string, unknown> = {};

  for (const [key, field] of Object.entries(shape)) {
    if (field.safeParse(undefined).success) continue;

    const value = [["x"], "x", 1, true, {}, "2026-09-03"].find(
      (candidate) => field.safeParse(candidate).success,
    );
    if (value === undefined) {
      throw new Error(`${tool.name}: no minimal value found for the required field ${key}`);
    }
    args[key] = value;
  }

  return tool.inputSchema.parse(args) as Record<string, unknown>;
}

describe("calendar surface", () => {
  it.each(tools)("%s declares the read class only", (_name, tool) => {
    expect(tool.classes).toEqual(["read"]);
  });

  it.each(tools)("%s classifies any call as a read", (_name, tool) => {
    // Arbitrary arguments, write-shaped keys included: none may flip a read.
    const written = { ids: ["x"], destroy: true, send: true, onDestroyRemoveContents: true };

    expect(tool.classify(written)).toBe("read");
  });

  it.each(tools)("%s asks the user nothing, whatever the window", (_name, tool) => {
    expect(tool.precheck).toBeUndefined();
    expect(tool.confirmWhen).toBeUndefined();
  });

  it("shares the calendar_ prefix across both manifests, and names no tool twice", () => {
    const names = ALL_TOOLS.map((tool) => tool.name);

    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => name.startsWith("calendar_"))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it("sends nothing but the five reads on the wire, for every tool of both manifests", async () => {
    for (const tool of ALL_TOOLS) {
      const { context, requests } = fakeTransport(Array.from({ length: 8 }, () => ANY_RESPONSE));

      await tool.run(minimalArguments(tool), context);

      const methods = requests.flatMap((request) => request.methodCalls.map(([name]) => name));
      expect(methods.length, `${tool.name} emitted no JMAP call at all`).toBeGreaterThan(0);

      for (const method of methods) {
        expect(READS, `${tool.name} emitted ${method}, which is not one of the reads`).toContain(
          method,
        );
      }
    }
  });

  it("registers every tool on a session advertising calendars and availability", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: MANIFESTS,
      session: sessionWith([CAPABILITY_CALENDARS, CAPABILITY_PRINCIPALS_AVAILABILITY]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual(["calendar_search", "calendar_read", "calendar_availability"]);
    expect(report.skipped).toEqual([]);
  });

  it("keeps the reading tools when availability alone is missing, and names it", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: MANIFESTS,
      session: sessionWith([CAPABILITY_CALENDARS]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    // The whole point of the split: a server without the availability method
    // still searches and reads.
    expect(registered).toEqual(["calendar_search", "calendar_read"]);
    expect(report.skipped).toEqual([
      { domain: "calendar-availability", missing: [CAPABILITY_PRINCIPALS_AVAILABILITY] },
    ]);
  });

  it("registers nothing at all on a session without the calendars capability", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: MANIFESTS,
      session: sessionWith([CAPABILITY_MAIL]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual([]);
    // Each manifest names its own missing capability, so an operator reads why
    // the tools are absent without opening the code.
    expect(report.skipped).toEqual([
      { domain: "calendar", missing: [CAPABILITY_CALENDARS] },
      {
        domain: "calendar-availability",
        missing: [CAPABILITY_CALENDARS, CAPABILITY_PRINCIPALS_AVAILABILITY],
      },
    ]);
  });
});
