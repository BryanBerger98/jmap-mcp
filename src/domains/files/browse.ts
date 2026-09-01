import { z } from "zod";
import type {
  GetResponse,
  Invocation,
  QueryResponse,
  ResultReference,
} from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_FILENODE } from "../../jmap/types/core.js";
import type {
  FileNode,
  FileNodeComparator,
  FileNodeFilterCondition,
  FileNodeGetArguments,
  FileNodeQueryArguments,
} from "../../jmap/types/filenode.js";
import { NODE_TYPES } from "../../jmap/types/filenode.js";
import { defineTool } from "../../registry/define-tool.js";
import {
  DEFAULT_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  fingerprint,
  inRequestedOrder,
  takeWithinBudget,
} from "../../shared/pagination.js";
import { renderTable } from "../../shared/render.js";
import { isDirectory, NODE_COLUMNS, renderNodeRow } from "./node.js";

/** Explicit: omitting `properties` hands back every property the node carries. */
const ROW_PROPERTIES = ["id", "parentId", "nodeType", "name", "size", "type"] as const;

/** Enough to name the folder being listed, and nothing more. */
const SCOPE_PROPERTIES = ["id", "name", "nodeType"] as const;

/**
 * How much rendered text one page may spend. A node row is a name, a size and an
 * id, so the contacts budget fits it: the same page size, for rows of the same
 * order of length.
 */
const RESULT_BUDGET_CHARS = 3000;

/** `queryMaxResults` defaults to 5000 and is advertised nowhere: always send a limit. */
const MAX_LIMIT = 100;

const SORT_PROPERTIES = ["name", "size", "nodeType"] as const;

const inputSchema = z.strictObject({
  parentId: z
    .string()
    .optional()
    .describe("List the direct children of this folder, as files_browse returns its id."),
  ancestorId: z
    .string()
    .optional()
    .describe("Search the whole subtree under this folder, at any depth."),
  name: z.string().optional().describe("Exact name of the node, matched in full."),
  nameMatch: z.string().optional().describe("Substring matched against the name of the node."),
  nodeType: z
    .enum([...NODE_TYPES])
    .optional()
    .describe("Restrict to files or to folders."),
  minSize: z.number().int().min(0).optional().describe("Smallest size in bytes, folders excluded."),
  maxSize: z.number().int().min(0).optional().describe("Largest size in bytes, folders excluded."),
  sort: z
    .enum([...SORT_PROPERTIES])
    .optional()
    .describe("Order results by name, size or node type. The server sorts on nothing else."),
  descending: z.boolean().optional().describe("Reverse the order, ascending by default."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Nodes to fetch, ${DEFAULT_PAGE_SIZE} by default.`),
  cursor: z
    .string()
    .optional()
    .describe("Cursor from a previous page. Resend the same criteria with it, or it is refused."),
});

export const filesBrowse = defineTool({
  name: "files_browse",
  title: "Browse files",
  description:
    "Lists and searches the file storage of the account, one line per node: whether it is a file " +
    "or a folder, its name, its size, its MIME type, and the id files_fetch takes. " +
    "With no criterion at all, the top level is listed; with `parentId` the direct children of one " +
    "folder; with `ancestorId` a whole subtree; with a name, a type or a size and neither of those, " +
    "the search spans the account. " +
    "Three things this server cannot do, whatever the arguments: it cannot sort by date, it cannot " +
    "search inside the content of a file, and it cannot filter on a MIME type. " +
    "Folders are listed before files. A truncated page returns a cursor: pass it back along with " +
    "the same criteria to continue.",
  inputSchema,
  classes: ["read"],
  classify: () => "read",
  summarize: () => "List file nodes in the account.",
  run: async (input, { client, session }) => {
    const filter = buildFilter(input);
    const sort = buildSort(input);
    // The sort travels into the fingerprint alongside the filter: a position
    // only means something inside one ordering of one result set.
    const criteriaFingerprint = fingerprint({ filter, sort });
    const resumed = input.cursor === undefined ? undefined : decodeCursor(input.cursor);

    if (input.cursor !== undefined && resumed === undefined) {
      return { text: "Refused: that cursor is unreadable. Run the search again from the start." };
    }
    // Checked before the request, so criteria dropped along with the cursor never
    // turn into a walk of the whole storage served under an old position.
    if (resumed !== undefined && resumed.criteriaFingerprint !== criteriaFingerprint) {
      return {
        text:
          "Refused: that cursor was issued for other criteria, so its position points into a " +
          "different result set. Resend the criteria of the first page with it, or browse again " +
          "from the start.",
      };
    }

    const limit = input.limit ?? DEFAULT_PAGE_SIZE;
    const position = resumed?.position ?? 0;

    const queryArguments: FileNodeQueryArguments = {
      accountId: session.accountId,
      filter,
      sort,
      position,
      limit,
      calculateTotal: true,
    };

    const idsFromQuery: ResultReference = {
      resultOf: "0",
      name: "FileNode/query",
      path: "/ids",
    };

    // The folder being listed is named, not echoed as an id: "1c9f2" tells
    // nobody where they are. Read in the same round trip, and only when there is
    // one to name.
    const scopeId = input.parentId ?? input.ancestorId;
    const scopeArguments: FileNodeGetArguments = {
      accountId: session.accountId,
      ids: scopeId === undefined ? [] : [scopeId],
      properties: [...SCOPE_PROPERTIES],
    };

    const calls: Invocation[] = [
      ["FileNode/query", queryArguments, "0"],
      [
        "FileNode/get",
        {
          accountId: session.accountId,
          "#ids": idsFromQuery,
          properties: [...ROW_PROPERTIES],
        },
        "1",
      ],
    ];
    if (scopeId !== undefined) calls.push(["FileNode/get", scopeArguments, "2"]);

    const [query, fetched, scope] = await client.requestMany<
      [QueryResponse, GetResponse<FileNode>, GetResponse<FileNode>?]
    >([CAPABILITY_CORE, CAPABILITY_FILENODE], calls);

    if (resumed !== undefined && resumed.queryState !== query.queryState) {
      return {
        text:
          "Refused: the file storage changed since that cursor was issued, so the next page would " +
          "skip or repeat nodes. Browse again from the start.",
      };
    }

    const nodes = inRequestedOrder(query.ids, fetched.list);
    const { taken, remaining } = takeWithinBudget(
      nodes,
      (node) => Object.values(renderNodeRow(node)).join("  "),
      RESULT_BUDGET_CHARS,
    );

    const count =
      query.total === undefined
        ? `${taken.length} node(s) shown.`
        : `${query.total} node(s) match, ${taken.length} shown from position ${position}.`;

    const header = `${count} Listing ${describeScope(filter, scopeId, scope)}, folders first.`;
    const table = renderTable(foldersFirst(taken).map(renderNodeRow), NODE_COLUMNS);
    const text = `${header}\n\n${table}`;

    // A short page ends the run, and so does a full page that lands exactly on
    // the total: without that second test, the last page still hands back a
    // cursor and the client spends a round trip to be told the set is empty.
    const reachedTotal = query.total !== undefined && position + taken.length >= query.total;
    const exhausted = remaining === 0 && (query.ids.length < limit || reachedTotal);
    if (exhausted) return { text };

    return {
      text,
      nextCursor: encodeCursor({
        position: position + taken.length,
        queryState: query.queryState,
        criteriaFingerprint,
      }),
    };
  },
});

/**
 * Maps the input onto the nine conditions the server executes.
 *
 * Nothing named at all is a browse of the root, and the root is named by
 * `isTopLevel`: the draft carries no root node, so `parentId: null` is not a
 * condition and would be dropped in silence. A criterion given without a folder
 * to scope it searches the account, which is what a search is for.
 */
function buildFilter(input: z.infer<typeof inputSchema>): FileNodeFilterCondition {
  const filter: FileNodeFilterCondition = {};

  if (input.parentId !== undefined) filter.parentId = input.parentId;
  if (input.ancestorId !== undefined) filter.ancestorId = input.ancestorId;
  if (input.name !== undefined) filter.name = input.name;
  if (input.nameMatch !== undefined) filter.nameMatch = input.nameMatch;
  if (input.nodeType !== undefined) filter.nodeType = input.nodeType;
  if (input.minSize !== undefined) filter.minSize = input.minSize;
  if (input.maxSize !== undefined) filter.maxSize = input.maxSize;

  return Object.keys(filter).length === 0 ? { isTopLevel: true } : filter;
}

/** Name ascending by default: the one order a person reading a folder expects. */
function buildSort(input: z.infer<typeof inputSchema>): FileNodeComparator[] {
  return [{ property: input.sort ?? "name", isAscending: input.descending !== true }];
}

/**
 * Folders before files, inside the page and not across the run.
 *
 * Applied after the budget has cut the page, never before: the cut has to follow
 * the order the server paginated in, or the next position would point past nodes
 * this page never showed. Reordering the survivors changes no membership, and
 * `sort` is stable, so the server's order survives inside each group.
 */
function foldersFirst(nodes: readonly FileNode[]): FileNode[] {
  return [...nodes].sort((left, right) => Number(isDirectory(right)) - Number(isDirectory(left)));
}

/** Where the listing looked, in the words the caller would use for it. */
function describeScope(
  filter: FileNodeFilterCondition,
  scopeId: string | undefined,
  scope: GetResponse<FileNode> | undefined,
): string {
  if (scopeId === undefined) {
    return filter.isTopLevel === true ? "the top level" : "the whole account";
  }

  // Guarded twice over: the scope read may come back with the node missing from
  // `list`, and a listing must not fail over the wording of its own header.
  const name = scope?.list?.[0]?.name;
  const where = name === undefined ? scopeId : `${name} (${scopeId})`;
  return filter.parentId === undefined ? `everything under ${where}` : where;
}
