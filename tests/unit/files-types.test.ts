import { describe, expect, it } from "vitest";
import {
  type FileNodeComparator,
  type FileNodeFilterCondition,
  type FileNodeSetArguments,
  NODE_TYPES,
  type NodeType,
  type OnExists,
} from "../../src/jmap/types/filenode.js";

/**
 * The three closed lists of `filenode.ts`, asserted where they are enforced:
 * the compiler.
 *
 * Every `@ts-expect-error` below is the assertion. It fails the typecheck the
 * day the error it expects stops being raised, which is the day the type stopped
 * closing the list. Nothing here can be checked at run time — by then the
 * offending condition has already been sent.
 */

describe("FileNodeSetArguments", () => {
  it("does not compile without onExists and onDestroyRemoveChildren", () => {
    // @ts-expect-error — both are mandatory here, optional in the draft.
    const forgotten: FileNodeSetArguments = { accountId: "acc-1", destroy: ["fn-1"] };

    expect(forgotten.accountId).toBe("acc-1");
  });

  it("compiles once both are stated", () => {
    const stated: FileNodeSetArguments = {
      accountId: "acc-1",
      destroy: ["fn-1"],
      onDestroyRemoveChildren: false,
      onExists: null,
    };

    expect(stated.onExists).toBeNull();
  });

  it("spells the four values of onExists and no others", () => {
    const every: OnExists[] = [null, "replace", "rename", "newest"];
    // @ts-expect-error — "reject" is spelled as the absent value, never as a string.
    const misspelled: OnExists = "reject";

    expect(every).toHaveLength(4);
    expect(misspelled).toBe("reject");
  });
});

describe("FileNodeFilterCondition", () => {
  it("carries the nine conditions the server executes", () => {
    const honoured: FileNodeFilterCondition = {
      parentId: "fn-1",
      ancestorId: "fn-1",
      descendantId: "fn-3",
      isTopLevel: true,
      nodeType: "file",
      name: "report.pdf",
      nameMatch: "report",
      minSize: 1,
      maxSize: 2,
    };

    expect(Object.keys(honoured)).toHaveLength(9);
  });

  it("does not compile on a condition Stalwart parses and drops", () => {
    // @ts-expect-error — `text` falls into an empty arm at file/query.rs:159-177.
    const searchesContent: FileNodeFilterCondition = { text: "invoice" };
    // @ts-expect-error — the six date bounds fall into the same arm.
    const searchesDates: FileNodeFilterCondition = { createdBefore: "2026-01-01T00:00:00Z" };

    expect(searchesContent).toBeDefined();
    expect(searchesDates).toBeDefined();
  });
});

describe("FileNodeComparator", () => {
  it("sorts on the three properties the cache can order", () => {
    const sortable: FileNodeComparator[] = [
      { property: "name", isAscending: true },
      { property: "size", isAscending: false },
      { property: "nodeType", isAscending: true },
    ];

    expect(sortable).toHaveLength(3);
  });

  it("does not compile on a date sort, which is dropped rather than refused", () => {
    // @ts-expect-error — removed from the list at file/query.rs:213-226, in silence.
    const byCreation: FileNodeComparator = { property: "created", isAscending: true };
    // @ts-expect-error — same arm, same silence.
    const byChange: FileNodeComparator = { property: "modified", isAscending: true };

    expect(byCreation.isAscending).toBe(true);
    expect(byChange.isAscending).toBe(true);
  });
});

describe("NODE_TYPES", () => {
  it("offers files and directories, and nothing else", () => {
    expect([...NODE_TYPES]).toEqual(["file", "directory"]);
  });

  it("does not compile on symlink, for which the server returns an empty set", () => {
    // @ts-expect-error — parsed by Stalwart, matched by nothing.
    const link: NodeType = "symlink";

    expect(link).toBe("symlink");
  });
});
