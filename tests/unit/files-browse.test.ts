import { describe, expect, it } from "vitest";
import { filesBrowse } from "../../src/domains/files/browse.js";
import type { GetResponse, Id } from "../../src/jmap/types/core.js";
import type { FileNode, FileNodeFilterCondition } from "../../src/jmap/types/filenode.js";
import { decodeCursor } from "../../src/shared/pagination.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const NODES = loadFixture<GetResponse<FileNode>>("file-node-get.json");

function queryResponse(ids: Id[], total = ids.length) {
  return {
    accountId: "acc-1",
    queryState: "file-query-1",
    canCalculateChanges: false,
    position: 0,
    ids,
    total,
  };
}

function getResponse(list: FileNode[]): GetResponse<FileNode> {
  return { accountId: "acc-1", state: "file-state-1", list, notFound: [] };
}

/** The filter of the `FileNode/query` the run emitted, whatever else it sent. */
function emittedFilter(requests: { methodCalls: [string, Record<string, unknown>, string][] }[]) {
  const call = requests
    .flatMap((request) => request.methodCalls)
    .find(([name]) => name === "FileNode/query");

  return call?.[1].filter as FileNodeFilterCondition | undefined;
}

describe("files_browse input schema", () => {
  it("refuses a condition the server parses and drops", () => {
    expect(filesBrowse.inputSchema.safeParse({ text: "invoice" }).success).toBe(false);
    expect(filesBrowse.inputSchema.safeParse({ createdAfter: "2026-01-01" }).success).toBe(false);
  });

  it("refuses a sort the server would silently ignore", () => {
    expect(filesBrowse.inputSchema.safeParse({ sort: "created" }).success).toBe(false);
    expect(filesBrowse.inputSchema.safeParse({ sort: "modified" }).success).toBe(false);
    expect(filesBrowse.inputSchema.safeParse({ sort: "name" }).success).toBe(true);
  });

  it("offers the three sortable properties and nothing else", () => {
    for (const property of ["name", "size", "nodeType"]) {
      expect(filesBrowse.inputSchema.safeParse({ sort: property }).success).toBe(true);
    }
  });
});

describe("files_browse description", () => {
  it("names the three things the server cannot do", () => {
    expect(filesBrowse.description).toContain("cannot sort by date");
    expect(filesBrowse.description).toContain("cannot search inside the content");
    expect(filesBrowse.description).toContain("cannot filter on a MIME type");
  });
});

describe("files_browse", () => {
  it("lists the top level with isTopLevel, never with a null parentId", async () => {
    const { context, requests } = fakeTransport([
      queryResponse(["fn-1", "fn-2", "fn-5"]),
      getResponse(NODES.list.filter((node) => node.parentId === null)),
    ]);

    const result = await filesBrowse.run({}, context);

    expect(emittedFilter(requests)).toEqual({ isTopLevel: true });
    expect(JSON.stringify(requests[0])).not.toContain('"parentId":null');
    expect(result.text).toContain("Listing the top level");
  });

  it("asks for one folder and names it in the header", async () => {
    const { context, requests } = fakeTransport([
      queryResponse(["fn-3", "fn-4"]),
      getResponse(NODES.list.filter((node) => node.parentId === "fn-1")),
      getResponse([NODES.list[0] as FileNode]),
    ]);

    const result = await filesBrowse.run({ parentId: "fn-1" }, context);

    expect(emittedFilter(requests)).toEqual({ parentId: "fn-1" });
    expect(result.text).toContain("Listing Documents (fn-1)");
    expect(requests[0]?.methodCalls).toHaveLength(3);
  });

  it("searches a subtree under an ancestor and says so", async () => {
    const { context, requests } = fakeTransport([
      queryResponse(["fn-3"]),
      getResponse([NODES.list[2] as FileNode]),
      getResponse([NODES.list[0] as FileNode]),
    ]);

    const result = await filesBrowse.run({ ancestorId: "fn-1", nameMatch: "report" }, context);

    expect(emittedFilter(requests)).toEqual({ ancestorId: "fn-1", nameMatch: "report" });
    expect(result.text).toContain("Listing everything under Documents (fn-1)");
  });

  it("searches the whole account when a criterion is given without a folder", async () => {
    const { context, requests } = fakeTransport([
      queryResponse(["fn-3"]),
      getResponse([NODES.list[2] as FileNode]),
    ]);

    const result = await filesBrowse.run({ nameMatch: "report" }, context);

    expect(emittedFilter(requests)).toEqual({ nameMatch: "report" });
    expect(result.text).toContain("Listing the whole account");
  });

  it("emits only conditions the server executes, whatever it was given", async () => {
    const { context, requests } = fakeTransport([
      queryResponse([]),
      getResponse([]),
      getResponse([NODES.list[0] as FileNode]),
    ]);

    await filesBrowse.run(
      { parentId: "fn-1", nodeType: "file", minSize: 1, maxSize: 2, name: "a", nameMatch: "b" },
      context,
    );

    expect(Object.keys(emittedFilter(requests) ?? {}).sort()).toEqual([
      "maxSize",
      "minSize",
      "name",
      "nameMatch",
      "nodeType",
      "parentId",
    ]);
  });

  it("sorts by name ascending by default, and reverses on request", async () => {
    const { context, requests } = fakeTransport([
      queryResponse([]),
      getResponse([]),
      queryResponse([]),
      getResponse([]),
    ]);

    await filesBrowse.run({}, context);
    await filesBrowse.run({ sort: "size", descending: true }, context);

    const sorts = requests
      .flatMap((request) => request.methodCalls)
      .filter(([name]) => name === "FileNode/query")
      .map(([, args]) => args.sort);

    expect(sorts[0]).toEqual([{ property: "name", isAscending: true }]);
    expect(sorts[1]).toEqual([{ property: "size", isAscending: false }]);
  });

  it("puts folders before files in the page it renders", async () => {
    // The server answered files first: the reordering is ours, not its.
    const shuffled = ["fn-5", "fn-1", "fn-2"];
    const { context } = fakeTransport([
      queryResponse(shuffled),
      getResponse(NODES.list.filter((node) => shuffled.includes(node.id))),
    ]);

    const result = await filesBrowse.run({}, context);
    const rows = result.text.split("\n").slice(4);

    expect(rows.map((row) => row.slice(0, 4).trim())).toEqual(["dir", "dir", "file"]);
  });

  it("leaves the size and the MIME type of a folder blank in the table", async () => {
    const { context } = fakeTransport([
      queryResponse(["fn-1"]),
      getResponse([NODES.list[0] as FileNode]),
    ]);

    const result = await filesBrowse.run({}, context);
    const row = result.text.split("\n").at(-1) ?? "";

    expect(row).toContain("Documents");
    expect(row).not.toMatch(/0 B|null|application\//);
  });
});

describe("files_browse pagination", () => {
  const many: FileNode[] = Array.from({ length: 100 }, (_, index) => ({
    id: `fn-${index}`,
    parentId: "fn-1",
    nodeType: "file" as const,
    blobId: `blob-${index}`,
    size: 4096,
    name: `a-rather-long-file-name-that-eats-the-render-budget-${index}.pdf`,
    type: "application/pdf",
  }));

  it("truncates the page and hands back a cursor at the right rank", async () => {
    const { context } = fakeTransport([
      queryResponse(
        many.map((node) => node.id),
        200,
      ),
      getResponse(many),
      getResponse([NODES.list[0] as FileNode]),
    ]);

    const result = await filesBrowse.run({ parentId: "fn-1", limit: 100 }, context);
    const shown = result.text.split("\n").length - 4;

    expect(shown).toBeLessThan(many.length);
    expect(result.nextCursor).toBeDefined();
    expect(decodeCursor(result.nextCursor ?? "")?.position).toBe(shown);
  });

  it("hands back no cursor when the page exhausts the result set", async () => {
    const { context } = fakeTransport([
      queryResponse(["fn-1", "fn-2", "fn-5"]),
      getResponse(NODES.list.filter((node) => node.parentId === null)),
    ]);

    const result = await filesBrowse.run({}, context);

    expect(result.nextCursor).toBeUndefined();
  });

  it("refuses a cursor issued for other criteria, before it queries anything", async () => {
    const { context, requests } = fakeTransport([
      queryResponse(["fn-3", "fn-4"], 200),
      getResponse(NODES.list.filter((node) => node.parentId === "fn-1")),
      getResponse([NODES.list[0] as FileNode]),
    ]);

    const first = await filesBrowse.run({ parentId: "fn-1", limit: 1 }, context);
    const spent = requests.length;

    const resumed = await filesBrowse.run({ parentId: "fn-2", cursor: first.nextCursor }, context);

    expect(resumed.text).toContain("issued for other criteria");
    expect(requests).toHaveLength(spent);
  });

  it("refuses an unreadable cursor", async () => {
    const { context, requests } = fakeTransport([]);

    const result = await filesBrowse.run({ cursor: "not-a-cursor" }, context);

    expect(result.text).toContain("unreadable");
    expect(requests).toHaveLength(0);
  });
});
