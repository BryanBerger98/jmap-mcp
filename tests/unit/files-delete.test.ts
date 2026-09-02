import { describe, expect, it } from "vitest";
import { countSubtree, filesDelete } from "../../src/domains/files/delete.js";
import type { JmapClient } from "../../src/jmap/client.js";
import type { GetResponse, Invocation } from "../../src/jmap/types/core.js";
import type { FileNode } from "../../src/jmap/types/filenode.js";
import type { ToolContext } from "../../src/registry/define-tool.js";
import { MAX_IDS_PER_CALL } from "../../src/shared/batch.js";
import { type FakeTransport, fakeTransport, loadFixture } from "../fixtures/client.js";

const NODES = loadFixture<GetResponse<FileNode>>("file-node-get.json");

function only(...ids: string[]): GetResponse<FileNode> {
  return {
    accountId: "acc-1",
    state: "file-state-1",
    list: NODES.list.filter((node) => ids.includes(node.id)),
    notFound: [],
  };
}

/** As many folders as a test needs, to overrun what one request may carry. */
function manyFolders(count: number): GetResponse<FileNode> {
  const template = NODES.list.find((node) => node.id === "fn-1") as FileNode;

  return {
    accountId: "acc-1",
    state: "file-state-1",
    list: Array.from({ length: count }, (_, index) => ({
      ...template,
      id: `dir-${index}`,
      name: `Folder ${index}`,
    })),
    notFound: [],
  };
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

/** The same answer from a server that declined to compute the total. */
function withoutTotal() {
  const { total: _dropped, ...rest } = total(0);
  return rest;
}

function destroyed(ids: readonly string[]) {
  return {
    accountId: "acc-1",
    oldState: "file-state-1",
    newState: "file-state-2",
    destroyed: [...ids],
  };
}

function partlyDestroyed(ids: readonly string[], refused: Record<string, unknown>) {
  return {
    accountId: "acc-1",
    oldState: "file-state-1",
    newState: "file-state-2",
    destroyed: ids.filter((id) => refused[id] === undefined),
    notDestroyed: refused,
  };
}

function calls(sent: FakeTransport["requests"]): Invocation[] {
  return sent.flatMap((request) => request.methodCalls);
}

/**
 * A context whose reads answer and whose counts fail.
 *
 * The fake transport never fails a round trip, and the case that matters most
 * here is exactly the one where it does: a count nobody could establish must
 * not read as an empty folder.
 */
function withFailingCount(context: ToolContext, nodes: GetResponse<FileNode>): ToolContext {
  const client = {
    request: async () => nodes,
    requestMany: async () => {
      throw new Error("the network is down");
    },
  } as unknown as JmapClient;

  return { ...context, client };
}

describe("countSubtree", () => {
  it("counts files and folders apart, one query for each", async () => {
    const { context, requests } = fakeTransport([only("fn-1"), total(4), total(1)]);

    const tree = await countSubtree(["fn-1"], context);

    expect(tree.unreadable).toBe(false);
    expect(tree.counts.get("fn-1")).toEqual({ files: 4, directories: 1 });
    expect(calls(requests).map((call) => call[0])).toEqual([
      "FileNode/get",
      "FileNode/query",
      "FileNode/query",
    ]);
  });

  it("asks the server for descendants at any depth, and for the count alone", async () => {
    const { context, requests } = fakeTransport([only("fn-1"), total(0), total(0)]);

    await countSubtree(["fn-1"], context);
    const [, files, directories] = calls(requests);

    expect(files?.[1]).toEqual({
      accountId: "acc-1",
      filter: { ancestorId: "fn-1", nodeType: "file" },
      limit: 1,
      calculateTotal: true,
    });
    expect(directories?.[1]).toMatchObject({
      filter: { ancestorId: "fn-1", nodeType: "directory" },
    });
  });

  it("counts once, however many hooks ask", async () => {
    const { context, requests } = fakeTransport([only("fn-1"), total(4), total(1)]);

    await filesDelete.precheck?.({ ids: ["fn-1"], withChildren: true }, context);
    await filesDelete.summarize({ ids: ["fn-1"], withChildren: true }, context);

    // One `/get` and one request carrying both `/query` calls: a second count
    // could disagree with the one the refusal was decided on.
    expect(requests).toHaveLength(2);
  });

  it("splits the counting queries into requests the server will accept", async () => {
    // Nine folders make eighteen calls, past the sixteen the fixture session
    // states: one request would come back rejected whole, and the tool would
    // read that transport refusal as a subtree it could not count.
    const ids = Array.from({ length: 9 }, (_, index) => `dir-${index}`);
    const totals = ids.flatMap((_, index) => [total(index), total(0)]);
    const { context, requests } = fakeTransport([manyFolders(ids.length), ...totals]);

    const tree = await countSubtree(ids, context);

    expect(tree.unreadable).toBe(false);
    expect(tree.counts.get("dir-0")).toEqual({ files: 0, directories: 0 });
    expect(tree.counts.get("dir-8")).toEqual({ files: 8, directories: 0 });
    // One `/get`, then the queries in requests of at most sixteen calls.
    expect(requests.map((request) => request.methodCalls.length)).toEqual([1, 16, 2]);
  });

  it("queries nothing when no folder is named", async () => {
    const { context, requests } = fakeTransport([only("fn-3", "fn-4")]);

    const tree = await countSubtree(["fn-3", "fn-4"], context);

    expect(tree.counts.size).toBe(0);
    expect(tree.unreadable).toBe(false);
    expect(calls(requests).map((call) => call[0])).toEqual(["FileNode/get"]);
  });

  it("treats a total the server declined to compute as a count it does not have", async () => {
    const { context } = fakeTransport([only("fn-1"), withoutTotal(), withoutTotal()]);

    expect((await countSubtree(["fn-1"], context)).unreadable).toBe(true);
  });

  it("treats a failed read as a tree it does not have", async () => {
    const { context } = fakeTransport([]);
    const failing = {
      ...context,
      client: {
        request: async () => {
          throw new Error("the network is down");
        },
      } as unknown as JmapClient,
    };

    expect((await countSubtree(["fn-1"], failing)).unreadable).toBe(true);
  });
});

describe("files_delete refusals", () => {
  it("refuses a populated folder, naming it and what it holds", async () => {
    const { context } = fakeTransport([only("fn-1"), total(4), total(0)]);

    const refusal = await filesDelete.precheck?.({ ids: ["fn-1"], withChildren: false }, context);

    expect(refusal).toContain("Documents (fn-1)");
    expect(refusal).toContain("4 files");
    expect(refusal).toContain("withChildren");
  });

  it("lets an empty folder through", async () => {
    const { context } = fakeTransport([only("fn-2"), total(0), total(0)]);

    expect(
      await filesDelete.precheck?.({ ids: ["fn-2"], withChildren: false }, context),
    ).toBeUndefined();
  });

  it("lets a populated folder through once the cascade is asked for", async () => {
    const { context } = fakeTransport([only("fn-1"), total(4), total(1)]);

    expect(
      await filesDelete.precheck?.({ ids: ["fn-1"], withChildren: true }, context),
    ).toBeUndefined();
  });

  it("refuses a count it could not establish, cascade or not", async () => {
    const nodes = only("fn-1");

    for (const withChildren of [false, true]) {
      const { context } = fakeTransport([]);
      const refusal = await filesDelete.precheck?.(
        { ids: ["fn-1"], withChildren },
        withFailingCount(context, nodes),
      );

      expect(refusal).toContain("could not be counted");
      expect(refusal).toContain("Nothing was destroyed");
    }
  });

  it("refuses more identifiers than one call may carry, before it reads anything", async () => {
    const { context, requests } = fakeTransport([]);
    const ids = Array.from({ length: MAX_IDS_PER_CALL + 1 }, (_, index) => `fn-${index}`);

    const refusal = await filesDelete.precheck?.({ ids, withChildren: false }, context);

    expect(refusal).toContain("file node ids");
    expect(requests).toHaveLength(0);
  });
});

describe("files_delete confirmation", () => {
  it("counts files and folders apart, and says nothing catches them", async () => {
    const { context } = fakeTransport([only("fn-3", "fn-5")]);

    const said = await filesDelete.summarize(
      { ids: ["fn-3", "fn-5"], withChildren: false },
      context,
    );

    expect(said).toContain("2 file nodes");
    expect(said).toContain("report.pdf (fn-3)");
    expect(said).toContain("no trash");
  });

  it("counts the subtree the cascade takes along", async () => {
    const { context } = fakeTransport([only("fn-1"), total(4), total(1)]);

    const said = await filesDelete.summarize({ ids: ["fn-1"], withChildren: true }, context);

    expect(said).toContain("everything under them");
    expect(said).toContain("4 files and 1 folder");
  });
});

describe("files_delete run", () => {
  it("destroys, and carries neither a cascade nor a replacement", async () => {
    const { context, requests } = fakeTransport([destroyed(["fn-3", "fn-4"])]);

    const result = await filesDelete.run({ ids: ["fn-3", "fn-4"], withChildren: false }, context);
    const [set] = calls(requests);

    expect(set?.[0]).toBe("FileNode/set");
    expect(set?.[1]).toEqual({
      accountId: "acc-1",
      destroy: ["fn-3", "fn-4"],
      onDestroyRemoveChildren: false,
      onExists: null,
    });
    expect(result.text).toContain("2 file nodes destroyed");
  });

  it("carries the cascade only where it was asked for", async () => {
    const { context, requests } = fakeTransport([destroyed(["fn-1"])]);

    await filesDelete.run({ ids: ["fn-1"], withChildren: true }, context);

    expect(calls(requests)[0]?.[1]).toMatchObject({
      onDestroyRemoveChildren: true,
      onExists: null,
    });
  });

  it("writes nothing but a destruction: no update and no creation rides along", async () => {
    const { context, requests } = fakeTransport([destroyed(["fn-3"])]);

    await filesDelete.run({ ids: ["fn-3"], withChildren: false }, context);
    const args = calls(requests)[0]?.[1] ?? {};

    expect(args).not.toHaveProperty("update");
    expect(args).not.toHaveProperty("create");
  });

  it("accounts for an id the server refused, id by id", async () => {
    const ids = ["fn-3", "fn-404", "fn-5"];
    const { context } = fakeTransport([
      partlyDestroyed(ids, { "fn-404": { type: "notFound", description: "no such node" } }),
    ]);

    const result = await filesDelete.run({ ids, withChildren: false }, context);

    expect(result.text).toContain("2 of 3 file nodes destroyed");
    expect(result.text).toContain("notFound — no such node");
    expect(result.text).toContain("fn-3");
  });
});

describe("files_delete surface", () => {
  it("takes ids, and neither a path nor a search condition", () => {
    expect(filesDelete.inputSchema.safeParse({ ids: ["fn-3"] }).success).toBe(true);
    expect(filesDelete.inputSchema.safeParse({ ids: ["fn-3"], path: "/tmp/x" }).success).toBe(
      false,
    );
    expect(filesDelete.inputSchema.safeParse({ ids: ["fn-3"], nameMatch: "*.pdf" }).success).toBe(
      false,
    );
    expect(filesDelete.inputSchema.safeParse({ ids: [] }).success).toBe(false);
  });

  it("leaves the cascade off unless the call asks for it", () => {
    const parsed = filesDelete.inputSchema.parse({ ids: ["fn-3"] }) as { withChildren: boolean };

    expect(parsed.withChildren).toBe(false);
  });

  it("destroys whatever the arguments say: the cascade widens, it never softens", () => {
    expect(filesDelete.classes).toEqual(["destroy"]);
    expect(filesDelete.classify({ ids: ["fn-3"], withChildren: false })).toBe("destroy");
    expect(filesDelete.classify({ ids: ["fn-1"], withChildren: true })).toBe("destroy");
  });
});
