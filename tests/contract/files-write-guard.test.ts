import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInputRequiredResult, type McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import type { Config } from "../../src/config/schema.js";
import { filesWritingDomain } from "../../src/domains/files/index.js";
import type { JmapClient } from "../../src/jmap/client.js";
import type { JmapSession } from "../../src/jmap/session.js";
import type { GetResponse, Id, JmapRequest } from "../../src/jmap/types/core.js";
import { CAPABILITY_FILENODE, CAPABILITY_MAIL } from "../../src/jmap/types/core.js";
import type { FileNode } from "../../src/jmap/types/filenode.js";
import { compose } from "../../src/registry/compose.js";
import type { ToolDefinition } from "../../src/registry/define-tool.js";
import { MAX_IDS_PER_CALL } from "../../src/shared/batch.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

/**
 * The invariant this file exists for: nothing on the writing surface of the file
 * storage can replace or erase a node without the user having been told what
 * disappears first.
 *
 * Two assertions carry it. `onExists` is `null` on every `FileNode/set` this
 * surface emits, including the ones that create — a server default is not a
 * guarantee, and an argument left out shows up on no unit test. And a
 * destruction emits nothing but reads until the confirmation comes back true.
 *
 * Written over `filesWritingDomain.tools`, so a tool added to the manifest is
 * held to the same guarantees the day it lands.
 */

const NODES = loadFixture<GetResponse<FileNode>>("file-node-get.json");
const SETS = loadFixture<Record<string, unknown>>("file-node-set.json");

/** The read fixture narrowed to the ids one case is about. */
function only(...ids: Id[]): GetResponse<FileNode> {
  return { ...NODES, list: NODES.list.filter((node) => ids.includes(node.id)) };
}

/** A `FileNode/query` answer whose only useful half is the total. */
function total(count: number) {
  return {
    accountId: "acc-1",
    queryState: "file-query-1",
    canCalculateChanges: false,
    position: 0,
    ids: [],
    total: count,
  };
}

/**
 * Every key that would let a call name a set of nodes instead of listing them.
 *
 * A destructive or bulk write that took a filter would act on whatever the
 * filter matched at that instant, which is never what was shown to the caller.
 * `path` is not among them: on `files_write` it names one local file to read,
 * and the assertion below pins the destroying tool's keys exactly.
 */
const CRITERIA = [
  "query",
  "search",
  "text",
  "filter",
  "nameMatch",
  "ancestorId",
  "minSize",
  "maxSize",
  "cursor",
  "position",
];

/**
 * What it takes to reach the destroying branch of each tool, and what the server
 * has to answer before the confirmation is due.
 *
 * Hand-written, on the `calendar_write_guard` pattern: the arguments that
 * classify as `destroy` are the tool's own business, and a guess derived from
 * the schema would confirm nothing about the real path. The exhaustiveness test
 * below is what keeps this map honest.
 */
const DESTROYING: Record<string, { input: Record<string, unknown>; responses: unknown[] }> = {
  files_delete: {
    input: { ids: ["fn-3", "fn-4"], withChildren: false },
    responses: [only("fn-3", "fn-4"), SETS.destroyed],
  },
};

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

/** A fresh directory per test: a deposit reads from it, and each test owns its own. */
let root: string;

const DEPOSITED = "the bytes of a report\n";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jmap-mcp-files-guard-"));
  await writeFile(join(root, "report.pdf"), DEPOSITED);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function writingSurface(
  responses: unknown[],
  capabilities: Record<string, unknown> | null,
  options: { bulkConfirmAbove?: number; files?: Config["files"] } = {},
) {
  const files = options.files ?? { localRoot: root };
  const { context, requests, blobs } = fakeTransport(
    responses,
    undefined,
    options.bulkConfirmAbove,
    undefined,
    files,
  );
  const handlers = new Map<string, Handler>();

  compose({
    server: {
      registerTool(name: string, _config: unknown, cb: Handler) {
        handlers.set(name, cb);
      },
      ...(capabilities === null ? {} : { server: { getClientCapabilities: () => capabilities } }),
    } as unknown as McpServer,
    domains: [filesWritingDomain],
    session: advertisingFiles(context.session),
    client: context.client,
    policy: DEFAULT_POLICY,
    blobs: context.blobs,
    files,
    ...(options.bulkConfirmAbove === undefined
      ? {}
      : { bulkConfirmAbove: options.bulkConfirmAbove }),
  });

  return {
    handlers,
    requests,
    blobs,
    write: handlers.get("files_write") as Handler,
    destroy: handlers.get("files_delete") as Handler,
  };
}

/**
 * The session fixture, plus the file storage capability it does not advertise.
 *
 * The account it stands for is a mail account; gating is tested on its own
 * below, and a manifest registering nothing here would make every assertion of
 * this file pass on an empty handler map.
 */
function advertisingFiles(session: JmapSession): JmapSession {
  return Object.assign(Object.create(session) as JmapSession, {
    has: (uri: string) => uri === CAPABILITY_FILENODE || session.has(uri),
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

function nodeSets(requests: JmapRequest[]): Record<string, unknown>[] {
  return requests.flatMap((request) =>
    request.methodCalls
      .filter(([name]) => name === "FileNode/set")
      .map(([, args]) => args as Record<string, unknown>),
  );
}

function textOf(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((part) => part.text ?? "").join("");
}

function keysOf(tool: ToolDefinition): string[] {
  return Object.keys((tool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>).shape);
}

const TOOLS = filesWritingDomain.tools.map((tool) => [tool.name, tool] as const);

const DESTROYERS = filesWritingDomain.tools.filter((tool) => tool.classes.includes("destroy"));

/**
 * Every path this surface can take to a `FileNode/set`, deposit and cascade
 * included. Validated by mutation: making `onExists` overridable in
 * `fileNodeSetArguments` turns the first assertion of `an emitted write` red.
 */
const PATHS: {
  name: string;
  tool: string;
  input: Record<string, unknown>;
  responses: unknown[];
}[] = [
  {
    name: "a deposit",
    tool: "files_write",
    input: { action: "upload", path: "report.pdf" },
    responses: [SETS.created],
  },
  {
    name: "a folder",
    tool: "files_write",
    input: { action: "create-folder", name: "Invoices" },
    responses: [SETS.createdFolder],
  },
  {
    name: "a move",
    tool: "files_write",
    input: { action: "organize", ids: ["fn-3", "fn-4"], parentId: null },
    responses: [SETS.updated],
  },
  {
    name: "a destruction",
    tool: "files_delete",
    input: { ids: ["fn-3", "fn-4"], withChildren: false },
    responses: [only("fn-3", "fn-4"), SETS.destroyed],
  },
  {
    name: "a destruction that cascades",
    tool: "files_delete",
    input: { ids: ["fn-1"], withChildren: true },
    responses: [only("fn-1"), total(4), total(1), SETS.destroyed],
  },
];

describe("the writing manifest", () => {
  it("names every destroying tool in the cases below, so none escapes them", () => {
    // The day a tool declares `destroy` without an entry here, this goes red
    // rather than letting the tool through untested.
    expect(DESTROYERS.map((tool) => tool.name).sort()).toEqual(Object.keys(DESTROYING).sort());
  });

  it.each(TOOLS)("%s carries no search criterion, only ids and fields", (_name, tool) => {
    expect(keysOf(tool).filter((key) => CRITERIA.includes(key))).toEqual([]);
  });

  it.each(TOOLS)("%s shares the files_ prefix", (name) => {
    expect(name.startsWith("files_")).toBe(true);
  });

  it("destroys on ids alone: no path, no pattern, nothing to rerun", () => {
    const tool = filesWritingDomain.tools.find((each) => each.name === "files_delete");

    expect(keysOf(tool as ToolDefinition).sort()).toEqual(["ids", "withChildren"]);
    expect(tool?.classes).toEqual(["destroy"]);
    // The cascade widens what disappears; it never changes what the call is.
    expect(tool?.classify({ ids: ["fn-3"], withChildren: false } as never)).toBe("destroy");
    expect(tool?.classify({ ids: ["fn-1"], withChildren: true } as never)).toBe("destroy");
  });

  it("writes as a draft, whichever of its three actions is asked for", () => {
    const tool = filesWritingDomain.tools.find((each) => each.name === "files_write");

    expect(tool?.classes).toEqual(["draft"]);
    for (const action of ["upload", "create-folder", "organize"]) {
      expect(tool?.classify({ action } as never)).toBe("draft");
    }
  });
});

describe("gating", () => {
  it("registers the writing tools on a session advertising the file storage", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: [filesWritingDomain],
      session: sessionWith([CAPABILITY_FILENODE]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual(filesWritingDomain.tools.map((tool) => tool.name));
    expect(report.skipped).toEqual([]);
  });

  it("registers nothing without the capability, and names the one that is missing", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: [filesWritingDomain],
      session: sessionWith([CAPABILITY_MAIL]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual([]);
    expect(report.skipped).toEqual([{ domain: "files-writing", missing: [CAPABILITY_FILENODE] }]);
  });
});

describe("an emitted write", () => {
  it.each(PATHS)("$name refuses to replace anything", async ({ tool, input, responses }) => {
    const { handlers, requests } = writingSurface(responses, { elicitation: {} });

    await handlers.get(tool)?.(input, CONFIRMED);

    const emitted = nodeSets(requests);
    // Vacuously true if nothing was written, so the count is asserted first.
    expect(emitted).toHaveLength(1);
    expect(Object.hasOwn(emitted[0] as object, "onExists")).toBe(true);
    expect(emitted[0]?.onExists).toBeNull();
  });

  it.each(PATHS)("$name states its cascade explicitly", async ({ tool, input, responses }) => {
    const { handlers, requests } = writingSurface(responses, { elicitation: {} });

    await handlers.get(tool)?.(input, CONFIRMED);

    const emitted = nodeSets(requests);
    expect(emitted).toHaveLength(1);
    expect(Object.hasOwn(emitted[0] as object, "onDestroyRemoveChildren")).toBe(true);
    expect(typeof emitted[0]?.onDestroyRemoveChildren).toBe("boolean");
    // True on the one path that asked for it, and on no other.
    expect(emitted[0]?.onDestroyRemoveChildren).toBe(input.withChildren === true);
  });

  it.each(PATHS.filter((path) => path.tool === "files_write"))(
    "$name never travels with a destruction",
    async ({ tool, input, responses }) => {
      const { handlers, requests } = writingSurface(responses, { elicitation: {} });

      await handlers.get(tool)?.(input, CONFIRMED);

      for (const args of nodeSets(requests)) expect(args.destroy).toBeUndefined();
    },
  );

  it.each(PATHS.filter((path) => path.tool === "files_delete"))(
    "$name never travels with a write",
    async ({ tool, input, responses }) => {
      const { handlers, requests } = writingSurface(responses, { elicitation: {} });

      await handlers.get(tool)?.(input, CONFIRMED);

      for (const args of nodeSets(requests)) {
        expect(args.create).toBeUndefined();
        expect(args.update).toBeUndefined();
      }
    },
  );
});

describe("a destroying file tool", () => {
  it.each(Object.entries(DESTROYING))(
    "%s is refused outright on a client that cannot be asked",
    async (name, { input, responses }) => {
      const { handlers, requests } = writingSurface(responses, { roots: {} });

      const result = await handlers.get(name)?.(input, UNANSWERED);

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toContain("elicitation");
      expect(writesIn(requests)).toEqual([]);
    },
  );

  it.each(Object.entries(DESTROYING))(
    "%s puts the call to the user, and destroys nothing while it waits",
    async (name, { input, responses }) => {
      const { handlers, requests } = writingSurface(responses, { elicitation: {} });

      const result = await handlers.get(name)?.(input, UNANSWERED);

      expect(isInputRequiredResult(result)).toBe(true);
      expect(JSON.stringify(result)).toContain("no trash");
      expect(writesIn(requests)).toEqual([]);
    },
  );

  it.each(Object.entries(DESTROYING))(
    "%s emits reads at most, never a write, when the confirmation comes back false",
    async (name, { input, responses }) => {
      const { handlers, requests } = writingSurface(responses, { elicitation: {} });

      await handlers.get(name)?.(input, DECLINED);

      // A read may precede the question — `precheck` and `summarize` both run
      // before it by design, so a doomed call is never put to the user and the
      // question can name what it is about. Nothing else may be emitted: the
      // assertion is on every method, not only on the `/set` that would destroy.
      expect(writesIn(requests)).toEqual([]);
      for (const method of methodsOf(requests)) {
        expect(method === "FileNode/get" || method === "FileNode/query").toBe(true);
      }
    },
  );

  it.each(Object.entries(DESTROYING))(
    "%s destroys only once the confirmation is granted",
    async (name, { input, responses }) => {
      const { handlers, requests } = writingSurface(responses, { elicitation: {} });

      await handlers.get(name)?.(input, CONFIRMED);

      const emitted = nodeSets(requests);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.destroy).toEqual(input.ids);
    },
  );
});

describe("the refusals that precede the question", () => {
  it("refuses a batch past the hard ceiling, before the subtree is even counted", async () => {
    const { destroy, requests } = writingSurface([], { elicitation: {} });

    const ids = Array.from({ length: MAX_IDS_PER_CALL + 1 }, (_, index) => `fn-${index}`);
    const result = await destroy({ ids, withChildren: false }, CONFIRMED);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain(`batches of ${MAX_IDS_PER_CALL}`);
    expect(methodsOf(requests)).toEqual([]);
  });

  it("refuses a populated folder without a cascade, before the question is asked", async () => {
    const { destroy, requests } = writingSurface(
      [only("fn-1"), total(4), total(0), SETS.destroyed],
      { elicitation: {} },
    );

    const result = await destroy({ ids: ["fn-1"], withChildren: false }, CONFIRMED);

    expect(isInputRequiredResult(result)).toBe(false);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("Documents (fn-1)");
    expect(writesIn(requests)).toEqual([]);
  });

  it("refuses a deposit from outside the configured directory before a byte moves", async () => {
    const { write, requests, blobs } = writingSurface([SETS.created], { elicitation: {} });

    const result = await write({ action: "upload", path: "../outside.pdf" }, CONFIRMED);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(methodsOf(requests)).toEqual([]);
    expect(blobs.uploads).toEqual([]);
  });
});

describe("the volume of an organize", () => {
  const THRESHOLD = 3;

  it("is put to the user past the threshold, without the call becoming a destruction", async () => {
    const { write, requests } = writingSurface(
      [only("fn-1"), only("fn-3", "fn-4")],
      { elicitation: {} },
      { bulkConfirmAbove: THRESHOLD },
    );

    const ids = Array.from({ length: THRESHOLD + 1 }, (_, index) => `fn-${index}`);
    const input = { action: "organize", ids, parentId: "fn-1" };
    const result = await write(input, UNANSWERED);

    expect(isInputRequiredResult(result)).toBe(true);
    expect(writesIn(requests)).toEqual([]);
    // The question comes from the volume, never from the class: moving nodes
    // stays a draft however many it touches.
    const tool = filesWritingDomain.tools.find((each) => each.name === "files_write");
    expect(tool?.classify(input as never)).toBe("draft");
  });
});
