import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { contactsDomain, contactsWritingDomain } from "../../src/domains/contacts/index.js";
import type { JmapClient } from "../../src/jmap/client.js";
import type { JmapSession } from "../../src/jmap/session.js";
import { CAPABILITY_CONTACTS, CAPABILITY_MAIL } from "../../src/jmap/types/core.js";
import { compose } from "../../src/registry/compose.js";
import type { ToolDefinition } from "../../src/registry/define-tool.js";
import { fakeTransport } from "../fixtures/client.js";

/**
 * The invariant this file exists for: the contacts manifest reads, and only
 * reads. Two assertions, deliberately kept apart — a tool declaring the `read`
 * class and a tool sending nothing but `get` and `query` on the wire are two
 * different claims, and the second is the one that protects an address book.
 *
 * It grows with the manifest rather than with a list copied out of it: a tool
 * added to `contactsDomain` is held to both the day it lands.
 */

/** A response shaped to satisfy a `get` and a `query` alike, so the queue never runs dry. */
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

/** Anything a JMAP method name can end with that is not a read. */
const WRITING_SUFFIXES = ["/set", "/copy", "/parse", "/import"];

const tools = contactsDomain.tools.map((tool) => [tool.name, tool] as const);

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
 * Derived from the schema rather than written down per tool, so the contract
 * keeps executing a tool whose arguments change. A required field that none of
 * the candidates satisfies throws here, which fails loudly instead of quietly
 * dropping that tool from the run.
 */
function minimalArguments(tool: ToolDefinition): Record<string, unknown> {
  const shape = (tool.inputSchema as unknown as { shape: Record<string, ZodType> }).shape;
  const args: Record<string, unknown> = {};

  for (const [key, field] of Object.entries(shape)) {
    if (field.safeParse(undefined).success) continue;

    const value = [["x"], "x", 1, true, {}].find((candidate) => field.safeParse(candidate).success);
    if (value === undefined) {
      throw new Error(`${tool.name}: no minimal value found for the required field ${key}`);
    }
    args[key] = value;
  }

  return tool.inputSchema.parse(args) as Record<string, unknown>;
}

describe("contacts surface", () => {
  it.each(tools)("%s declares the read class only", (_name, tool) => {
    expect(tool.classes).toEqual(["read"]);
  });

  it.each(tools)("%s classifies any call as a read", (_name, tool) => {
    // Arbitrary arguments, write-shaped keys included: none may flip a read.
    const written = { ids: ["x"], destroy: true, send: true, onDestroyRemoveContents: true };

    expect(tool.classify(written)).toBe("read");
  });

  it.each(tools)("%s asks the user nothing, whatever the volume", (_name, tool) => {
    expect(tool.precheck).toBeUndefined();
    expect(tool.confirmWhen).toBeUndefined();
  });

  it("shares the contacts_ prefix, and names no tool twice", () => {
    const names = contactsDomain.tools.map((tool) => tool.name);

    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => name.startsWith("contacts_"))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it("shares no tool with the writing manifest, which is what makes it provable", () => {
    // The split is the whole proof: a writing tool listed here too would inherit
    // the read-only claims above while writing, and every assertion in this file
    // would be about a surface that is not the one exposed.
    const reading = new Set(contactsDomain.tools.map((tool) => tool.name));
    const writing = contactsWritingDomain.tools.map((tool) => tool.name);

    expect(writing.length).toBeGreaterThan(0);
    expect(writing.filter((name) => reading.has(name))).toEqual([]);
  });

  it("sends nothing but get and query on the wire, for every tool of the manifest", async () => {
    for (const tool of contactsDomain.tools) {
      const { context, requests } = fakeTransport(Array.from({ length: 8 }, () => ANY_RESPONSE));

      await tool.run(minimalArguments(tool), context);

      const methods = requests.flatMap((request) => request.methodCalls.map(([name]) => name));
      expect(methods.length, `${tool.name} emitted no JMAP call at all`).toBeGreaterThan(0);

      for (const method of methods) {
        expect(
          method.endsWith("/get") || method.endsWith("/query"),
          `${tool.name} emitted ${method}, which is not a read`,
        ).toBe(true);

        for (const suffix of WRITING_SUFFIXES) {
          expect(method.endsWith(suffix), `${tool.name} emitted ${method}`).toBe(false);
        }
      }
    }
  });

  it("registers both tools on a session that advertises contacts", () => {
    const registered: string[] = [];

    compose({
      server: fakeServer(registered),
      domains: [contactsDomain],
      session: sessionWith([CAPABILITY_CONTACTS]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual(contactsDomain.tools.map((tool) => tool.name));
    expect(registered).toContain("contacts_search");
    expect(registered).toContain("contacts_read");
  });

  it("registers nothing at all on a session without the contacts capability", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: [contactsDomain, contactsWritingDomain],
      session: sessionWith([CAPABILITY_MAIL]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    // Neither manifest, not just the reading one: an account with no address
    // book must not be offered a tool that writes to one either.
    expect(registered).toEqual([]);
    // The report names the capability, so an operator learns why the tools are
    // missing without reading the manifest.
    expect(report.skipped).toEqual([
      { domain: "contacts", missing: [CAPABILITY_CONTACTS] },
      { domain: "contacts-writing", missing: [CAPABILITY_CONTACTS] },
    ]);
  });
});
