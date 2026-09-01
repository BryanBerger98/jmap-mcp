import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { filesDomain } from "../../src/domains/files/index.js";
import { LOCAL_ROOT_KEY } from "../../src/domains/files/local.js";
import type { JmapClient } from "../../src/jmap/client.js";
import type { JmapSession } from "../../src/jmap/session.js";
import { CAPABILITY_FILENODE, CAPABILITY_MAIL } from "../../src/jmap/types/core.js";
import type { FileNodeFilterCondition } from "../../src/jmap/types/filenode.js";
import { compose } from "../../src/registry/compose.js";
import type { ToolDefinition } from "../../src/registry/define-tool.js";
import { fakeTransport } from "../fixtures/client.js";

/**
 * The invariant this file exists for: the file surface reads, and only reads.
 *
 * Two claims kept apart, as in the contacts and calendar contracts — a tool
 * declaring the `read` class and a tool sending nothing but reads on the wire
 * are different assertions, and the second is the one that protects a document.
 *
 * A third claim is specific to this domain. `FileNode/query` parses twenty-two
 * conditions and executes nine: a filter naming one of the other thirteen is
 * dropped in silence and comes back with more nodes than it asked for. The
 * whitelist below is the one the tools may emit, and a search that lied about
 * its criteria would be a search that deleted the wrong thing at the next step.
 */

/** Every read this surface is allowed to emit. Whole method names, never suffixes. */
const READS = ["FileNode/get", "FileNode/query"];

/** The nine conditions `file/query.rs:159-177` actually executes. */
const HONOURED: (keyof FileNodeFilterCondition)[] = [
  "parentId",
  "ancestorId",
  "descendantId",
  "isTopLevel",
  "nodeType",
  "name",
  "nameMatch",
  "minSize",
  "maxSize",
];

/** A response shaped to satisfy a get and a query alike. */
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

const TOOLS = filesDomain.tools;
const tools = TOOLS.map((tool) => [tool.name, tool] as const);

/**
 * A configured local directory, so a fetch reaches the wire instead of stopping
 * at its own precheck. Nothing is ever written under it: `ANY_RESPONSE` names no
 * node, so every run refuses on the missing id, after its read and before its
 * download.
 */
const CONFIGURED_ROOT = join(tmpdir(), "jmap-mcp-read-only-contract");

/** A transport every tool of the surface can run against, wired for reading. */
function reading() {
  return fakeTransport(
    Array.from({ length: 8 }, () => ANY_RESPONSE),
    undefined,
    undefined,
    undefined,
    { localRoot: CONFIGURED_ROOT },
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
 * Derived from the schema, so a tool whose arguments change stays covered, and
 * so a tool added to the manifest is held to the contract without it being
 * rewritten.
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

describe("files surface", () => {
  it.each(tools)("%s declares the read class only", (_name, tool) => {
    expect(tool.classes).toEqual(["read"]);
  });

  it.each(tools)("%s classifies any call as a read", (_name, tool) => {
    // Arbitrary arguments, write-shaped keys included: none may flip a read.
    const written = { id: "x", destroy: true, onDestroyRemoveChildren: true, onExists: "replace" };

    expect(tool.classify(written)).toBe("read");
  });

  it.each(tools)("%s never escalates a call to a confirmation", (_name, tool) => {
    expect(tool.confirmWhen).toBeUndefined();
  });

  it("carries one precheck across the surface, and it is the local directory", async () => {
    const { context } = fakeTransport([]);
    const withPrecheck = TOOLS.filter((tool) => tool.precheck !== undefined);

    expect(withPrecheck.map((tool) => tool.name)).toEqual(["files_fetch"]);

    for (const tool of withPrecheck) {
      const refusal = await tool.precheck?.(minimalArguments(tool), context);
      expect(refusal, `${tool.name} refused for a reason other than the local directory`).toContain(
        LOCAL_ROOT_KEY,
      );
    }
  });

  it("shares the files_ prefix, and names no tool twice", () => {
    const names = TOOLS.map((tool) => tool.name);

    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => name.startsWith("files_"))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it("sends nothing but the two reads on the wire, for every tool of the manifest", async () => {
    for (const tool of TOOLS) {
      const { context, requests } = reading();

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

  it("moves no byte through the JMAP endpoint", async () => {
    for (const tool of TOOLS) {
      const { context, requests } = reading();

      await tool.run(minimalArguments(tool), context);

      const body = JSON.stringify(requests);
      expect(body, `${tool.name} put a blob argument on the JMAP endpoint`).not.toMatch(
        /"data:|"blobIds"/,
      );
    }
  });

  it("emits no condition the server would parse and drop", async () => {
    // Every argument the schemas offer, so no accepted input escapes the check.
    const everything = {
      parentId: "fn-1",
      ancestorId: "fn-1",
      name: "report.pdf",
      nameMatch: "report",
      nodeType: "file",
      minSize: 1,
      maxSize: 2,
      sort: "size",
      descending: true,
      limit: 10,
      id: "fn-3",
      saveAs: "copy.pdf",
    };

    for (const tool of TOOLS) {
      const { context, requests } = reading();
      const accepted = tool.inputSchema.safeParse(everything);

      await tool.run(accepted.success ? accepted.data : minimalArguments(tool), context);

      const filters = requests
        .flatMap((request) => request.methodCalls)
        .filter(([name]) => name === "FileNode/query")
        .map(([, args]) => (args.filter ?? {}) as Record<string, unknown>);

      for (const filter of filters) {
        for (const condition of Object.keys(filter)) {
          expect(
            HONOURED,
            `${tool.name} filtered on ${condition}, which the server drops in silence`,
          ).toContain(condition);
        }
      }
    }
  });

  it("registers every tool on a session advertising file nodes", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: [filesDomain],
      session: sessionWith([CAPABILITY_FILENODE]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual(["files_browse", "files_fetch"]);
    expect(report.skipped).toEqual([]);
  });

  it("registers nothing without the file node capability, and names it", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: [filesDomain],
      session: sessionWith([CAPABILITY_MAIL]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual([]);
    expect(report.skipped).toEqual([{ domain: "files", missing: [CAPABILITY_FILENODE] }]);
  });
});
