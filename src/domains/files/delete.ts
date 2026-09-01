import { z } from "zod";
import type {
  CoreCapability,
  Id,
  Invocation,
  QueryResponse,
  SetResponse,
} from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_FILENODE } from "../../jmap/types/core.js";
import type { FileNode, FileNodeQueryArguments } from "../../jmap/types/filenode.js";
import { defineTool, type ToolContext } from "../../registry/define-tool.js";
import { refuseOversizedBatch } from "../../shared/batch.js";
import { FILE_NODES, fileNodeSetArguments } from "./edit.js";
import { describeNodeOutcome, describeNodes, isDirectory, resolveNodes } from "./node.js";

/** What lives under one folder, at any depth. */
export interface SubtreeCount {
  files: number;
  directories: number;
}

/**
 * What a call is about to destroy, read once and used twice.
 *
 * `unreadable` is the load-bearing field. Anything that stops the count from
 * being established — a failed read, a server that ignores `calculateTotal` —
 * sets it, and a set it cannot count is a set this tool refuses to destroy.
 */
export interface Subtrees {
  nodes: FileNode[];
  counts: Map<Id, SubtreeCount>;
  unreadable: boolean;
}

/** Assumed when the session states no `maxCallsInRequest`. Stalwart ships 16. */
const CONSERVATIVE_MAX_CALLS = 8;

const inputSchema = z.strictObject({
  ids: z
    .array(z.string())
    .min(1)
    .describe("The node ids to destroy, exactly as files_browse returned them."),
  withChildren: z
    .boolean()
    .default(false)
    .describe(
      "Destroy a folder together with everything under it. False by default, and a folder that " +
        "still holds something is refused rather than emptied.",
    ),
});

export const filesDelete = defineTool({
  name: "files_delete",
  title: "Destroy files and folders",
  description:
    "Destroys the named files and folders. This is permanent: the file storage has no trash, " +
    "nothing holds a destroyed node and no later call brings it back. " +
    "A folder that still holds something is refused unless `withChildren` is set, in which case " +
    "the whole subtree goes in one call and the confirmation counts it first. " +
    "It acts on ids only — run files_browse and pass the ids it returned, because a search rerun " +
    "here could match nodes you never saw.",
  inputSchema,
  // One class on every argument: `withChildren` widens how much disappears, and
  // changes nothing about what the call does.
  classes: ["destroy"],
  classify: () => "destroy",
  summarize: async (input, context) => {
    const tree = await countSubtree(input.ids, context);

    return (
      `Permanently destroy ${describeNodes(tree.nodes, input.ids.length)}` +
      `${describeSubtrees(tree, input.withChildren)}. ` +
      "The file storage has no trash: nothing recovers them afterwards."
    );
  },
  precheck: async (input, context) => {
    // The ceiling first, before the tree is read: fifty-one ids are refused
    // whatever they point at, and counting them would spend a round trip to
    // reach the same answer.
    const oversized = refuseOversizedBatch(input.ids, FILE_NODES);
    if (oversized !== undefined) return oversized;

    const tree = await countSubtree(input.ids, context);
    if (tree.unreadable) {
      return (
        "Refused: what these ids hold could not be counted, so a confirmation would understate " +
        "what disappears. Run files_browse to check the subtree, then delete again. Nothing was " +
        "destroyed."
      );
    }

    return input.withChildren ? undefined : refusePopulated(tree);
  },
  run: async (input, context) => {
    // `destroy` alone: an `update` riding along would change nodes under a
    // confirmation the user read as a destruction, and a `create` would add one.
    const response = await context.client.request<SetResponse<FileNode>>(
      [CAPABILITY_CORE, CAPABILITY_FILENODE],
      [
        "FileNode/set",
        fileNodeSetArguments(context.session.accountId, {
          destroy: [...input.ids],
          // The one flag this server ever sets true, and only here: asked for
          // explicitly, counted beforehand, and confirmed.
          onDestroyRemoveChildren: input.withChildren === true,
        }),
        "0",
      ],
    );

    return { text: describeNodeOutcome(response, input.ids, "destroyed", "destroyed") };
  },
});

/**
 * The nodes an id set names, and what hangs under each folder among them.
 *
 * Counted once per handler invocation: `precheck` decides on it and `summarize`
 * spells it out, and asking the server twice would spend a round trip to learn
 * the same thing — worse, it could learn something else, and refuse on one tree
 * while confirming another.
 *
 * Two queries per folder rather than one, because a confirmation that said "12
 * things" would hide whether that is a dozen files or a dozen folders holding
 * more.
 */
export function countSubtree(ids: readonly Id[], context: ToolContext): Promise<Subtrees> {
  return context.once(`files:subtree:${[...ids].sort().join(",")}`, async () => {
    const nodes = await readNodes(ids, context);
    if (nodes === undefined) return { nodes: [], counts: new Map(), unreadable: true };

    const directories = nodes.filter(isDirectory);
    if (directories.length === 0) return { nodes, counts: new Map(), unreadable: false };

    const totals = await readTotals(directories, context);
    if (totals === undefined) return { nodes, counts: new Map(), unreadable: true };

    return { nodes, counts: totals, unreadable: false };
  });
}

/** The refusal a populated folder earns, naming the folder and what it holds. */
export function refusePopulated(tree: Subtrees): string | undefined {
  const populated = [...tree.counts.entries()].filter(([, count]) => held(count) > 0);
  if (populated.length === 0) return undefined;

  const named = populated.map(([id, count]) => {
    const node = tree.nodes.find((each) => each.id === id);
    return `${node?.name ?? id} (${id}) holds ${spell(count)}`;
  });

  return (
    `Refused: ${named.join(", ")}. Destroying a folder never destroys what is inside it, so this ` +
    "call would fail on the server. Empty the folder first, or pass withChildren to destroy the " +
    "whole subtree in one confirmed call."
  );
}

/** What the confirmation adds about the subtrees, when there is anything to add. */
function describeSubtrees(tree: Subtrees, withChildren: boolean): string {
  const total = [...tree.counts.values()].reduce(
    (sum, count) => ({
      files: sum.files + count.files,
      directories: sum.directories + count.directories,
    }),
    { files: 0, directories: 0 },
  );

  if (held(total) === 0) return "";

  return withChildren
    ? `, and everything under them: ${spell(total)}`
    : `, which hold ${spell(total)}`;
}

/** "4 files and 1 folder", or the half of it that is not zero. */
function spell(count: SubtreeCount): string {
  const parts = [
    count.files === 0 ? undefined : `${count.files} file${count.files === 1 ? "" : "s"}`,
    count.directories === 0
      ? undefined
      : `${count.directories} folder${count.directories === 1 ? "" : "s"}`,
  ].filter((part): part is string => part !== undefined);

  return parts.length === 0 ? "nothing" : parts.join(" and ");
}

function held(count: SubtreeCount): number {
  return count.files + count.directories;
}

/**
 * The nodes themselves, or nothing at all.
 *
 * A read that fails is not an empty tree: the caller gets a refusal rather than
 * a confirmation built on what could not be read.
 */
async function readNodes(
  ids: readonly Id[],
  context: ToolContext,
): Promise<FileNode[] | undefined> {
  try {
    return await resolveNodes(ids, context);
  } catch {
    return undefined;
  }
}

/**
 * How many files and folders hang under each of these folders.
 *
 * Two calls per folder, `calculateTotal` on: the ids are not wanted and `limit`
 * is 1 so the server sends as few as it will. A `total` the server declines to
 * compute makes the whole count unreadable rather than zero — a missing figure
 * read as an empty folder is exactly the mistake that would open a destruction.
 *
 * They no longer travel in one request. The batch ceiling admits fifty ids, so a
 * single request could carry a hundred calls where the server accepts sixteen,
 * and it rejects the whole request rather than the surplus: the count would come
 * back unreadable and the tool would refuse every deletion past eight folders,
 * blaming a subtree it never read.
 */
async function readTotals(
  directories: readonly FileNode[],
  context: ToolContext,
): Promise<Map<Id, SubtreeCount> | undefined> {
  const responses: QueryResponse[] = [];
  // Two calls per folder, so the request ceiling halves into a folder ceiling.
  const perRequest = Math.max(1, Math.floor(maxCallsInRequest(context) / 2));

  for (let start = 0; start < directories.length; start += perRequest) {
    const calls: Invocation[] = directories
      .slice(start, start + perRequest)
      .flatMap((directory, index) => [
        ["FileNode/query", descendants(directory.id, "file", context), `f${start + index}`],
        ["FileNode/query", descendants(directory.id, "directory", context), `d${start + index}`],
      ]);

    try {
      responses.push(
        ...(await context.client.requestMany<QueryResponse[]>(
          [CAPABILITY_CORE, CAPABILITY_FILENODE],
          calls,
        )),
      );
    } catch {
      return undefined;
    }
  }

  const counts = new Map<Id, SubtreeCount>();

  for (const [index, directory] of directories.entries()) {
    const files = responses[index * 2]?.total;
    const folders = responses[index * 2 + 1]?.total;
    if (files === undefined || folders === undefined) return undefined;

    counts.set(directory.id, { files, directories: folders });
  }

  return counts;
}

/**
 * What one request may carry, or a conservative default.
 *
 * Half of what Stalwart ships with, because a server that declines to state its
 * own ceiling is not one to guess high about: too low costs a round trip, too
 * high costs the whole request.
 */
function maxCallsInRequest(context: ToolContext): number {
  const core = context.session.raw.capabilities[CAPABILITY_CORE] as
    | Partial<CoreCapability>
    | undefined;
  const stated = core?.maxCallsInRequest;
  return stated !== undefined && stated > 0 ? stated : CONSERVATIVE_MAX_CALLS;
}

function descendants(
  ancestorId: Id,
  nodeType: "file" | "directory",
  context: ToolContext,
): FileNodeQueryArguments {
  return {
    accountId: context.session.accountId,
    filter: { ancestorId, nodeType },
    limit: 1,
    calculateTotal: true,
  };
}
