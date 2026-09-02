import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { sieveDomain, sieveVacationDomain } from "../../src/domains/sieve/index.js";
import type { JmapClient } from "../../src/jmap/client.js";
import type { JmapSession } from "../../src/jmap/session.js";
import {
  CAPABILITY_MAIL,
  CAPABILITY_SIEVE,
  CAPABILITY_VACATION,
} from "../../src/jmap/types/core.js";
import type {
  SieveScriptComparator,
  SieveScriptFilterCondition,
} from "../../src/jmap/types/sieve.js";
import { compose } from "../../src/registry/compose.js";
import type { ToolDefinition } from "../../src/registry/define-tool.js";
import { fakeTransport } from "../fixtures/client.js";
import { scriptBlobs, sieveGet, sieveQuery } from "../fixtures/sieve.js";

/**
 * The invariant this file exists for: the Sieve reading surface reads, and only
 * reads.
 *
 * Two claims kept apart, as in the contacts, calendar and files contracts — a
 * tool declaring the `read` class and a tool sending nothing but reads on the
 * wire are different assertions, and the second is the one that protects an
 * account's mail flow.
 *
 * The stakes here are not those of a document. Three arguments of
 * `SieveScript/set` change which script filters incoming mail, and one of them
 * is the `isActive` property itself, which the server translates back into an
 * activation (`sieve/set.rs:482-484` and `:358-368`). A reading tool that
 * reached `SieveScript/set` at all would be one argument away from rerouting
 * every message the account receives.
 */

/** Every read this surface may emit. Whole method names, never suffixes. */
const READS = ["SieveScript/get", "SieveScript/query"];

/** The two conditions `SieveScript/query` honours. */
const HONOURED: (keyof SieveScriptFilterCondition)[] = ["name", "isActive"];

/** The two properties it sorts on. */
const SORTABLE: SieveScriptComparator["property"][] = ["name", "isActive"];

/** A response shaped to satisfy a get and a query alike. */
const ANY_RESPONSE = { ...sieveQuery(), ...sieveGet() };

/**
 * Every input each tool of the manifest accepts, one per branch.
 *
 * Minimal arguments alone would exercise one branch of a tool discriminated on
 * `action` and leave the others unproven, so the branches are written out and an
 * exhaustiveness test below holds the table honest.
 */
const BRANCHES: Record<string, Record<string, unknown>[]> = {
  sieve_scripts: [
    { action: "list" },
    { action: "list", nameContains: "news" },
    { action: "show", id: "sc-1" },
  ],
};

const TOOLS = sieveDomain.tools;
const tools = TOOLS.map((tool) => [tool.name, tool] as const);

/** A transport every tool of the surface can run against, wired for reading. */
function reading() {
  return fakeTransport(
    Array.from({ length: 8 }, () => ANY_RESPONSE),
    { blobs: scriptBlobs },
  );
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
 */
function minimalArguments(tool: ToolDefinition): Record<string, unknown> {
  const shape = (tool.inputSchema as unknown as { shape: Record<string, ZodType> }).shape;
  const args: Record<string, unknown> = {};

  for (const [key, field] of Object.entries(shape)) {
    if (field.safeParse(undefined).success) continue;

    const declared = (field as unknown as { options?: unknown[] }).options ?? [];
    const value = [...declared, ["x"], "x", 1, true, {}].find(
      (candidate) => field.safeParse(candidate).success,
    );
    if (value === undefined) {
      throw new Error(`${tool.name}: no minimal value found for the required field ${key}`);
    }
    args[key] = value;
  }

  return tool.inputSchema.parse(args) as Record<string, unknown>;
}

/** Every method name a run put on the wire, in order. */
function methodsOf(requests: { methodCalls: [string, Record<string, unknown>, string][] }[]) {
  return requests.flatMap((request) => request.methodCalls.map(([name]) => name));
}

describe("sieve reading surface", () => {
  it.each(tools)("%s declares the read class only", (_name, tool) => {
    expect(tool.classes).toEqual(["read"]);
  });

  it.each(tools)("%s classifies any call as a read", (_name, tool) => {
    // Arbitrary arguments, write-shaped keys included: none may flip a read.
    const written = {
      action: "show",
      id: "sc-1",
      isActive: true,
      destroy: true,
      onSuccessActivateScript: "sc-1",
      onSuccessDeactivateScript: true,
    };

    expect(tool.classify(written)).toBe("read");
  });

  it.each(tools)("%s asks no question of its own", (_name, tool) => {
    // A read has nothing to confirm and nothing to refuse ahead of time.
    expect(tool.precheck).toBeUndefined();
    expect(tool.confirmWhen).toBeUndefined();
  });

  it("shares the sieve_ prefix, and names no tool twice", () => {
    const names = TOOLS.map((tool) => tool.name);

    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => name.startsWith("sieve_"))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names a branch for every tool of the manifest", () => {
    expect(Object.keys(BRANCHES).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
  });

  it("sends nothing but the two reads on the wire, on every branch", async () => {
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

  it("sends nothing but the two reads on the minimal arguments of each tool", async () => {
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

  it("filters and sorts on nothing the server would refuse", async () => {
    // Every argument the schemas offer, so no accepted input escapes the check.
    const everything = { action: "list", nameContains: "news", id: "sc-1" };

    for (const tool of TOOLS) {
      const { context, requests } = reading();
      const accepted = tool.inputSchema.safeParse(everything);

      await tool.run(accepted.success ? accepted.data : minimalArguments(tool), context);

      const queries = requests
        .flatMap((request) => request.methodCalls)
        .filter(([name]) => name === "SieveScript/query")
        .map(([, args]) => args);

      for (const args of queries) {
        for (const condition of Object.keys((args.filter ?? {}) as Record<string, unknown>)) {
          expect(
            HONOURED,
            `${tool.name} filtered on ${condition}, which the server answers UnsupportedFilter on`,
          ).toContain(condition);
        }

        for (const comparator of (args.sort ?? []) as SieveScriptComparator[]) {
          expect(
            SORTABLE,
            `${tool.name} sorted on ${comparator.property}, which the server refuses`,
          ).toContain(comparator.property);
        }
      }
    }
  });

  it("registers every tool on a session advertising sieve", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: [sieveDomain],
      session: sessionWith([CAPABILITY_SIEVE]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual(["sieve_scripts"]);
    expect(report.skipped).toEqual([]);
  });

  it("registers the scripts tools without the vacation capability", () => {
    // The two capabilities rest on two independent Stalwart permissions, so an
    // account may hold one and not the other: reading filters must not depend on
    // being allowed to read the vacation response.
    const registered: string[] = [];

    compose({
      server: fakeServer(registered),
      domains: [sieveDomain, sieveVacationDomain],
      session: sessionWith([CAPABILITY_SIEVE]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual(["sieve_scripts"]);
  });

  it("registers no script tool on a session advertising only the vacation response", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: [sieveDomain],
      session: sessionWith([CAPABILITY_VACATION]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual([]);
    expect(report.skipped).toEqual([{ domain: "sieve", missing: [CAPABILITY_SIEVE] }]);
  });

  it("registers nothing without the sieve capability, and names it", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: [sieveDomain],
      session: sessionWith([CAPABILITY_MAIL]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual([]);
    expect(report.skipped).toEqual([{ domain: "sieve", missing: [CAPABILITY_SIEVE] }]);
  });
});
