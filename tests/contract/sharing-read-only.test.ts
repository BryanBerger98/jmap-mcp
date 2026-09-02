import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { sharingDomain } from "../../src/domains/sharing/index.js";
import type { JmapClient } from "../../src/jmap/client.js";
import type { JmapSession } from "../../src/jmap/session.js";
import { CAPABILITY_MAIL, CAPABILITY_PRINCIPALS } from "../../src/jmap/types/core.js";
import { compose } from "../../src/registry/compose.js";
import type { ToolDefinition } from "../../src/registry/define-tool.js";
import {
  fullySharingSession,
  methodsOf,
  scriptedSharing,
  sharingScript,
} from "../fixtures/sharing.js";

/**
 * The invariant this file exists for: the sharing surface reads, and only reads.
 *
 * Two claims kept apart, as in the contacts, calendar, files and Sieve
 * contracts — a tool declaring the `read` class and a tool sending nothing but
 * reads on the wire are different assertions, and the second is the one that
 * matters here.
 *
 * What it protects is not a document but a boundary. `Mailbox/set`,
 * `Calendar/set`, `AddressBook/set` and `FileNode/set` each take a `shareWith`
 * map, and one of them reached from this surface would hand an outside account
 * standing access to a folder, an agenda or a file tree. `ShareNotification/set`
 * belongs to the writing surface too: dismissing a notification is how the
 * record of such a change disappears.
 */

/** Every read this surface may emit. Whole method names, never suffixes. */
const READS = [
  "Mailbox/get",
  "Calendar/get",
  "AddressBook/get",
  "FileNode/get",
  "Principal/get",
  "ShareNotification/get",
  "ShareNotification/query",
];

/**
 * Every input each tool of the manifest accepts, one per branch.
 *
 * Minimal arguments alone would exercise one branch of a tool discriminated on
 * `action` and leave the others unproven, so the branches are written out and an
 * exhaustiveness test below holds the table honest. The four object types are
 * each named: they reach four different `/get` methods, and only one of them
 * would show up under a single branch.
 */
const BRANCHES: Record<string, Record<string, unknown>[]> = {
  sharing_access: [
    { action: "received" },
    { action: "received", limit: 3 },
    { action: "object", objectType: "Mailbox", ids: ["mb-1"] },
    { action: "object", objectType: "Calendar", ids: ["cal-1"] },
    { action: "object", objectType: "AddressBook", ids: ["ab-1"] },
    { action: "object", objectType: "FileNode", ids: ["fn-1"] },
  ],
};

const TOOLS = sharingDomain.tools;
const tools = TOOLS.map((tool) => [tool.name, tool] as const);

/** A transport every branch can run against, on a server serving all four types. */
function reading() {
  return scriptedSharing(sharingScript(), fullySharingSession());
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

/**
 * The smallest input the tool's own schema accepts.
 *
 * Derived from the schema, so a tool whose arguments change stays covered. The
 * candidates start with the values an enum declares: a field discriminating on
 * `action` accepts none of the generic ones, and a contract that threw on it
 * would be a contract nobody could extend.
 *
 * Every combination is tried rather than the first value of each field. The
 * schema's refinements make some branches demand fields that are optional at the
 * field level — `object` needs `objectType` and `ids`, `received` needs neither
 * — so the smallest accepted input is not built one field at a time.
 */
function minimalArguments(tool: ToolDefinition): Record<string, unknown> {
  const shape = (tool.inputSchema as unknown as { shape: Record<string, ZodType> }).shape;

  const candidates = Object.entries(shape)
    .filter(([, field]) => !field.safeParse(undefined).success)
    .map(([key, field]) => {
      const declared = (field as unknown as { options?: unknown[] }).options ?? [];
      const accepted = [...declared, ["x"], "x", 1, true, {}].filter(
        (candidate) => field.safeParse(candidate).success,
      );
      if (accepted.length === 0) {
        throw new Error(`${tool.name}: no minimal value found for the required field ${key}`);
      }

      return { key, accepted };
    });

  const combinations = candidates.reduce<Record<string, unknown>[]>(
    (rows, { key, accepted }) =>
      rows.flatMap((row) => accepted.map((value) => ({ ...row, [key]: value }))),
    [{}],
  );

  for (const combination of combinations) {
    const parsed = tool.inputSchema.safeParse(combination);
    if (parsed.success) return parsed.data as Record<string, unknown>;
  }

  throw new Error(`${tool.name}: no minimal arguments its own schema accepts`);
}

describe("sharing reading surface", () => {
  it.each(tools)("%s declares the read class only", (_name, tool) => {
    expect(tool.classes).toEqual(["read"]);
  });

  it.each(tools)("%s classifies any call as a read", (_name, tool) => {
    // Arbitrary arguments, write-shaped keys included: none may flip a read.
    const written = {
      action: "object",
      objectType: "Mailbox",
      ids: ["mb-1"],
      shareWith: { "p-alice": { mayReadItems: true } },
      destroy: true,
      revoke: true,
    };

    expect(tool.classify(written)).toBe("read");
  });

  it.each(tools)("%s asks no question of its own", (_name, tool) => {
    // A read has nothing to confirm and nothing to refuse ahead of time.
    expect(tool.precheck).toBeUndefined();
    expect(tool.confirmWhen).toBeUndefined();
  });

  it("shares the sharing_ prefix, and names no tool twice", () => {
    const names = TOOLS.map((tool) => tool.name);

    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => name.startsWith("sharing_"))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names a branch for every tool of the manifest", () => {
    expect(Object.keys(BRANCHES).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
  });

  it("sends nothing but the seven reads on the wire, on every branch", async () => {
    for (const tool of TOOLS) {
      for (const input of BRANCHES[tool.name] ?? []) {
        const { context, requests } = reading();

        await tool.run(tool.inputSchema.parse(input), context);

        const methods = methodsOf(requests);
        expect(
          methods.length,
          `${tool.name} emitted no JMAP call at all on ${JSON.stringify(input)}`,
        ).toBeGreaterThan(0);

        for (const method of methods) {
          expect(READS, `${tool.name} emitted ${method}, which is not one of the reads`).toContain(
            method,
          );
        }
      }
    }
  });

  it("sends nothing but the seven reads on the minimal arguments of each tool", async () => {
    for (const tool of TOOLS) {
      const { context, requests } = reading();

      await tool.run(minimalArguments(tool), context);

      for (const method of methodsOf(requests)) {
        expect(READS, `${tool.name} emitted ${method}, which is not one of the reads`).toContain(
          method,
        );
      }
    }
  });

  it("never emits a set of any kind, on any branch", async () => {
    // Named apart from the whitelist above: `ShareNotification/set` dismisses the
    // record of a change, and the four object sets each carry a `shareWith` map.
    for (const tool of TOOLS) {
      for (const input of BRANCHES[tool.name] ?? []) {
        const { context, requests } = reading();

        await tool.run(tool.inputSchema.parse(input), context);

        for (const method of methodsOf(requests)) {
          expect(
            method.endsWith("/set"),
            `${tool.name} emitted ${method} on ${JSON.stringify(input)}`,
          ).toBe(false);
        }
      }
    }
  });

  it("registers every tool on a session advertising principals", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: [sharingDomain],
      session: sessionWith([CAPABILITY_PRINCIPALS]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual(["sharing_access"]);
    expect(report.skipped).toEqual([]);
  });

  it("registers nothing without the principals capability, and names it", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: [sharingDomain],
      session: sessionWith([CAPABILITY_MAIL]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual([]);
    expect(report.skipped).toEqual([{ domain: "sharing", missing: [CAPABILITY_PRINCIPALS] }]);
  });
});
