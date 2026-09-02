/**
 * File nodes to compact text.
 *
 * The four file tools render the same node, name the same set of nodes in a
 * refusal, and account for the same `FileNode/set`. Written once here so they
 * cannot diverge at the first correction. One function reads the network,
 * `resolveNodes`; everything else is pure and testable without a server.
 *
 * One rule runs through the whole file: a directory has no size and no MIME
 * type, and the draft makes both null on it. Rendering a zero or an invented
 * `application/octet-stream` would read as a fact about the folder.
 */

import type { GetResponse, Id, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_FILENODE } from "../../jmap/types/core.js";
import type { FileNode, FileNodeGetArguments } from "../../jmap/types/filenode.js";
import type { ToolContext } from "../../registry/define-tool.js";
import { describeSetError, renderTable } from "../../shared/render.js";

/**
 * What a `FileNode/get` is asked for when the whole node is wanted.
 *
 * Declared explicitly: omitting `properties` hands back every property the
 * server knows, and this list is what the renderings below actually read.
 */
export const NODE_PROPERTIES = [
  "id",
  "parentId",
  "nodeType",
  "blobId",
  "size",
  "name",
  "type",
] as const;

/** The columns of a node table, in reading order. */
export const NODE_COLUMNS = ["type", "name", "size", "mime", "id"];

/** How many nodes a refusal or a summary names before it counts the rest. */
const NODES_NAMED = 3;

/** Binary units, spelled as such: 180 KiB is 184320 bytes and says so. */
const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

/** The one test for a folder, so no tool spells the string itself. */
export function isDirectory(node: FileNode): boolean {
  return node.nodeType === "directory";
}

/**
 * A size a human reads, not a byte count they have to divide.
 *
 * Kept exact below a kibibyte, and given one decimal only where it carries
 * information: "180 KiB" is as precise as anybody needs, "180.0 KiB" is noise.
 */
export function formatSize(bytes: number): string {
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const shown = unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  return `${shown} ${UNITS[unit]}`;
}

/** One row of a node table. A directory leaves size and MIME type blank. */
export function renderNodeRow(node: FileNode): Record<string, unknown> {
  const directory = isDirectory(node);

  return {
    type: directory ? "dir" : "file",
    name: node.name ?? "",
    // Blank rather than zero: a folder has no size, which is not the same thing
    // as having a size of nothing.
    size: directory || node.size === null || node.size === undefined ? "" : formatSize(node.size),
    mime: directory ? "" : (node.type ?? ""),
    id: node.id,
  };
}

/**
 * "3 file nodes: report.pdf (fn-3), notes.txt (fn-4) and 1 more".
 *
 * A count alone is not something anyone can arbitrate: confirming the erasure of
 * "3 file nodes" is confirming a number. `total` lets a caller whose read came
 * back short still state how many the call touches, rather than report the
 * number it managed to name.
 */
export function describeNodes(nodes: readonly FileNode[], total = nodes.length): string {
  const count = `${total} file ${total === 1 ? "node" : "nodes"}`;
  if (nodes.length === 0) return count;

  const named = nodes
    .slice(0, NODES_NAMED)
    .map((node) => `${node.name ?? "(unnamed)"} (${node.id})`);
  const rest = total - named.length;

  return `${count}: ${named.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}

/**
 * Reads nodes by id, once per handler invocation.
 *
 * `summarize`, `precheck` and `run` each need the nodes the call points at, and
 * asking the server three times spends three round trips to learn the same
 * thing. The key is sorted so the same set asked in another order still hits.
 */
export async function resolveNodes(ids: readonly Id[], context: ToolContext): Promise<FileNode[]> {
  const args: FileNodeGetArguments = {
    accountId: context.session.accountId,
    ids: [...ids],
    properties: [...NODE_PROPERTIES],
  };

  const response = await context.once(`files:nodes:${[...ids].sort().join(",")}`, () =>
    context.client.request<GetResponse<FileNode>>(
      [CAPABILITY_CORE, CAPABILITY_FILENODE],
      ["FileNode/get", args, "0"],
    ),
  );

  return response.list;
}

/**
 * Accounts for a `FileNode/set`, id by id.
 *
 * `done` reads as a past participle — "moved", "destroyed" — so one rendering
 * serves every tool. An id absent from the refusals counts as done: the server
 * names what it refused, and reading success off `updated` instead would report
 * a node as untouched on a server that answers with a null patch.
 */
export function describeNodeOutcome(
  response: SetResponse<unknown>,
  ids: readonly Id[],
  done: string,
  half: "updated" | "destroyed" = "updated",
): string {
  const refused = (half === "updated" ? response.notUpdated : response.notDestroyed) ?? {};

  const rows = ids.map((id) => {
    const error = refused[id];
    return { id, outcome: error === undefined ? done : `refused: ${describeSetError(error)}` };
  });

  // Counted off the server's answer, never off the cell rendered from it: a
  // `done` wording that happened to read like a refusal would move the headline.
  const failed = ids.filter((id) => refused[id] !== undefined).length;
  const succeeded = rows.length - failed;

  const headline =
    failed === 0
      ? `${succeeded} file ${succeeded === 1 ? "node" : "nodes"} ${done}.`
      : succeeded === 0
        ? `No file node was ${done}: the server refused all ${rows.length}.`
        : `${succeeded} of ${rows.length} file nodes ${done}, ${failed} refused by the server.`;

  return `${headline}\n\n${renderTable(rows, ["id", "outcome"])}`;
}
