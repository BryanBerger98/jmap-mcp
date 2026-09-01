import { describe, expect, it } from "vitest";
import {
  describeNodeOutcome,
  describeNodeSetError,
  describeNodes,
  formatSize,
  isDirectory,
  renderNodeDetail,
  renderNodeRow,
  resolveNodes,
} from "../../src/domains/files/node.js";
import type { GetResponse, SetResponse } from "../../src/jmap/types/core.js";
import type { FileNode } from "../../src/jmap/types/filenode.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const NODES = loadFixture<GetResponse<FileNode>>("file-node-get.json");

function node(id: string): FileNode {
  const found = NODES.list.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`fixture has no node ${id}`);
  return found;
}

describe("formatSize", () => {
  it("keeps bytes exact below a kibibyte", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
  });

  it("gives one decimal only where it carries information", () => {
    expect(formatSize(2048)).toBe("2.0 KiB");
    expect(formatSize(15360)).toBe("15 KiB");
    expect(formatSize(184320)).toBe("180 KiB");
  });

  it("climbs the units", () => {
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MiB");
    expect(formatSize(2 * 1024 * 1024 * 1024)).toBe("2.0 GiB");
  });
});

describe("renderNodeRow", () => {
  it("shows the size and the MIME type of a file", () => {
    expect(renderNodeRow(node("fn-3"))).toEqual({
      type: "file",
      name: "report.pdf",
      size: "180 KiB",
      mime: "application/pdf",
      id: "fn-3",
    });
  });

  it("leaves a folder without a size and without a MIME type, not with a null one", () => {
    const row = renderNodeRow(node("fn-1"));

    expect(row).toEqual({ type: "dir", name: "Documents", size: "", mime: "", id: "fn-1" });
    // Rendered, the row must carry neither a zero nor an invented media type.
    expect(Object.values(row).join(" ")).not.toMatch(/null|0 B|octet-stream/);
  });
});

describe("renderNodeDetail", () => {
  it("names the parent of a nested file", () => {
    const detail = renderNodeDetail(node("fn-3"));

    expect(detail).toContain("name: report.pdf");
    expect(detail).toContain("size: 180 KiB");
    expect(detail).toContain("parent: fn-1");
  });

  it("says top level rather than null, and drops the size of a folder", () => {
    const detail = renderNodeDetail(node("fn-1"));

    expect(detail).toContain("parent: (top level)");
    expect(detail).not.toMatch(/^size:/m);
    expect(detail).not.toMatch(/^mime:/m);
  });

  it("names only the rights the account does not have", () => {
    const restricted: FileNode = {
      ...node("fn-3"),
      myRights: {
        mayRead: true,
        mayAddChildren: false,
        mayRename: true,
        mayDelete: false,
        mayModifyContent: true,
        mayShare: false,
      },
    };

    expect(renderNodeDetail(restricted)).toContain("rights: cannot delete");
  });
});

describe("describeNodes", () => {
  it("names every node when they fit", () => {
    expect(describeNodes([node("fn-3"), node("fn-4")])).toBe(
      "2 file nodes: report.pdf (fn-3), notes.txt (fn-4)",
    );
  });

  it("counts the rest past three", () => {
    expect(describeNodes(NODES.list)).toMatch(/^5 file nodes: .* and 2 more$/);
  });

  it("falls back to the count when the read came back empty", () => {
    expect(describeNodes([], 4)).toBe("4 file nodes");
  });
});

describe("resolveNodes", () => {
  it("reads the nodes by id", async () => {
    const { context, requests } = fakeTransport([NODES]);

    const nodes = await resolveNodes(["fn-3", "fn-4"], context);

    expect(nodes).toHaveLength(5);
    expect(requests[0]?.methodCalls[0]?.[0]).toBe("FileNode/get");
    expect(requests[0]?.methodCalls[0]?.[1]).toMatchObject({ ids: ["fn-3", "fn-4"] });
  });

  it("asks once per invocation, whatever the order of the ids", async () => {
    const { context, requests } = fakeTransport([NODES, NODES]);

    await resolveNodes(["fn-4", "fn-3"], context);
    await resolveNodes(["fn-3", "fn-4"], context);

    expect(requests).toHaveLength(1);
  });
});

describe("describeNodeOutcome", () => {
  it("reports every id as done when the server refused none", () => {
    const response: SetResponse<unknown> = { accountId: "acc-1", oldState: "s1", newState: "s2" };

    const text = describeNodeOutcome(response, ["fn-3", "fn-4"], "moved");

    expect(text).toContain("2 file nodes moved.");
    expect(text).toContain("fn-3");
  });

  it("separates the refusals from the rest and names their reason", () => {
    const response: SetResponse<unknown> = {
      accountId: "acc-1",
      oldState: "s1",
      newState: "s2",
      notDestroyed: { "fn-1": { type: "nodeHasChildren", description: "the folder is not empty" } },
    };

    const text = describeNodeOutcome(response, ["fn-1", "fn-3"], "destroyed", "destroyed");

    expect(text).toContain("1 of 2 file nodes destroyed, 1 refused by the server.");
    expect(text).toContain("nodeHasChildren — the folder is not empty");
  });

  it("says so plainly when nothing went through", () => {
    const response: SetResponse<unknown> = {
      accountId: "acc-1",
      oldState: "s1",
      newState: "s2",
      notUpdated: { "fn-3": { type: "forbidden" } },
    };

    expect(describeNodeOutcome(response, ["fn-3"], "moved")).toContain(
      "No file node was moved: the server refused all 1.",
    );
  });
});

describe("describeNodeSetError", () => {
  it("falls back to the type alone when the server described nothing", () => {
    expect(describeNodeSetError({ type: "alreadyExists" })).toBe("alreadyExists");
  });
});

describe("isDirectory", () => {
  it("tells the two node types apart", () => {
    expect(isDirectory(node("fn-1"))).toBe(true);
    expect(isDirectory(node("fn-3"))).toBe(false);
  });
});
