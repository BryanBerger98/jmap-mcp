import { describe, expect, it } from "vitest";
import {
  buildNodeCreation,
  buildNodePatch,
  explainSetError,
  fileNodeSetArguments,
  resolveParent,
} from "../../src/domains/files/edit.js";
import type { GetResponse } from "../../src/jmap/types/core.js";
import type { FileNode } from "../../src/jmap/types/filenode.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const NODES = loadFixture<GetResponse<FileNode>>("file-node-get.json");

function only(id: string): GetResponse<FileNode> {
  return {
    accountId: "acc-1",
    state: "file-state-1",
    list: NODES.list.filter((node) => node.id === id),
    notFound: [],
  };
}

describe("buildNodePatch", () => {
  it("carries only the paths the call named", () => {
    expect(buildNodePatch({ name: "renamed.pdf" })).toEqual({ name: "renamed.pdf" });
    expect(buildNodePatch({ parentId: "fn-2" })).toEqual({ parentId: "fn-2" });
    expect(buildNodePatch({ name: "a", parentId: "fn-2" })).toEqual({
      name: "a",
      parentId: "fn-2",
    });
  });

  it("treats a null parent as a value, not as an absence", () => {
    expect(buildNodePatch({ parentId: null })).toEqual({ parentId: null });
  });

  it("carries nothing when the call named nothing", () => {
    expect(buildNodePatch({})).toEqual({});
  });
});

describe("buildNodeCreation", () => {
  it("sends the whole object, since a creation has nothing to preserve", () => {
    expect(
      buildNodeCreation({
        nodeType: "file",
        name: "report.pdf",
        parentId: "fn-1",
        blobId: "blob-1",
        type: "application/pdf",
      }),
    ).toEqual({
      nodeType: "file",
      name: "report.pdf",
      parentId: "fn-1",
      blobId: "blob-1",
      type: "application/pdf",
    });
  });

  it("puts neither bytes nor a MIME type on a directory", () => {
    const created = buildNodeCreation({
      nodeType: "directory",
      name: "Invoices",
      blobId: "blob-1",
      type: "application/pdf",
    });

    expect(created).toEqual({ nodeType: "directory", name: "Invoices" });
    expect(created).not.toHaveProperty("blobId");
    expect(created).not.toHaveProperty("type");
  });

  it("keeps a null parent, which is the top level and not an omission", () => {
    expect(buildNodeCreation({ nodeType: "directory", name: "Top", parentId: null })).toEqual({
      nodeType: "directory",
      name: "Top",
      parentId: null,
    });
  });
});

describe("fileNodeSetArguments", () => {
  it("writes both flags on a call that carries nothing else", () => {
    expect(fileNodeSetArguments("acc-1")).toEqual({
      accountId: "acc-1",
      onExists: null,
      onDestroyRemoveChildren: false,
    });
  });

  it("lets a caller override the cascade, which files_delete does", () => {
    const args = fileNodeSetArguments("acc-1", {
      destroy: ["fn-3"],
      onDestroyRemoveChildren: true,
    });

    expect(args.onDestroyRemoveChildren).toBe(true);
    expect(args.destroy).toEqual(["fn-3"]);
  });

  it("lets no caller override onExists, whatever they pass", () => {
    const args = fileNodeSetArguments("acc-1", {
      // The type rules this out; the runtime must too, since a `set` that
      // replaced a node would destroy one without ever asking.
      onExists: "replace",
    } as unknown as Record<string, never>);

    expect(args.onExists).toBeNull();
  });
});

describe("explainSetError", () => {
  it("sends a name conflict to files_delete, the only path to a replacement", () => {
    const said = explainSetError({ type: "alreadyExists" });

    expect(said).toContain("files_delete");
    expect(said).toContain("never replaces");
  });

  it("explains a folder that still holds something", () => {
    expect(explainSetError({ type: "nodeHasChildren" })).toContain("still holds something");
  });

  it("explains an invalid property and a full account", () => {
    expect(explainSetError({ type: "invalidProperties" })).toContain("not acceptable");
    expect(explainSetError({ type: "overQuota" })).toContain("no room left");
  });

  it("falls back to what the server said on a type it does not know", () => {
    expect(explainSetError({ type: "forbidden" })).toContain("forbidden");
  });

  it("quotes the server's own description when there is one", () => {
    expect(explainSetError({ type: "overQuota", description: "quota is 1 GiB" })).toContain(
      "quota is 1 GiB",
    );
  });
});

describe("resolveParent", () => {
  it("reads the folder so a refusal can name it", async () => {
    const { context } = fakeTransport([only("fn-1")]);

    expect((await resolveParent("fn-1", context))?.name).toBe("Documents");
  });

  it("reads it once, however many times a handler asks", async () => {
    const { context, requests } = fakeTransport([only("fn-1")]);

    await resolveParent("fn-1", context);
    await resolveParent("fn-1", context);

    expect(requests).toHaveLength(1);
  });

  it("reads nothing for the top level, which is not a node", async () => {
    const { context, requests } = fakeTransport([]);

    expect(await resolveParent(null, context)).toBeUndefined();
    expect(await resolveParent(undefined, context)).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("hands back nothing when the id names no node", async () => {
    const { context } = fakeTransport([
      { accountId: "acc-1", state: "file-state-1", list: [], notFound: ["fn-404"] },
    ]);

    expect(await resolveParent("fn-404", context)).toBeUndefined();
  });
});
