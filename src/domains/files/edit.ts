/**
 * What writing to the file storage takes, shared by the tools that do it.
 *
 * Two things live here rather than in either tool. The first is `buildNodePatch`,
 * a pure function of a normalized request: a node written whole would erase the
 * properties the caller never named, and a `FileNode` carries `executable` and
 * `role` that no rendering of this server shows. The second is
 * `fileNodeSetArguments`, which is the only place `onExists` is written — and it
 * writes `null` every time, because replacing a file is a destruction and a
 * destruction goes through `files_delete`, where it is confirmed.
 *
 * Only `resolveParent` reads the network. Everything else is testable without a
 * server, which is the point: the rule that keeps a write from destroying
 * something should not need one to be checked.
 */

import type { GetResponse, Id, SetError } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_FILENODE } from "../../jmap/types/core.js";
import type {
  FileNode,
  FileNodeGetArguments,
  FileNodeSetArguments,
  NodePatch,
  NodeType,
} from "../../jmap/types/filenode.js";
import type { ToolContext } from "../../registry/define-tool.js";
import type { BatchSubject } from "../../shared/batch.js";
import { NODE_PROPERTIES } from "./node.js";

/** What a batch of nodes is made of, for the refusal every writing tool shares. */
export const FILE_NODES: BatchSubject = {
  noun: "file node",
  discoveredBy: "files_browse",
};

/** The key a creation is filed under: JMAP hands back the real id in `created`. */
export const CREATION_KEY = "new";

/** What a call asks to become of a node, in the caller's terms. */
export interface NodeEdit {
  name?: string | undefined;
  /** `null` moves the node to the top level; absent leaves it where it is. */
  parentId?: Id | null | undefined;
}

/** What a call asks to bring into being. A directory carries no bytes. */
export interface NodeCreation extends NodeEdit {
  nodeType: NodeType;
  blobId?: Id | undefined;
  type?: string | undefined;
}

/**
 * The patch one node is to receive, keyed by JSON pointer.
 *
 * Only the properties the call named, and each of them at the top level: a node
 * has no nested family to point into, so there is no prefix collision to make.
 * The guard below states that rather than assuming it, because the day a nested
 * path is added is the day RFC 8620 §5.3 starts applying here too.
 */
export function buildNodePatch(edit: NodeEdit): NodePatch {
  const patch: NodePatch = {};

  if (edit.name !== undefined) patch.name = edit.name;
  // `null` is a value here, not an absence: it is how a node is moved out of a
  // folder and up to the top level.
  if (edit.parentId !== undefined) patch.parentId = edit.parentId;

  refusePrefixCollision(patch);
  return patch;
}

/**
 * The object a creation sends: a whole node, since nothing exists to preserve.
 *
 * `blobId` and `type` go on a file and never on a directory. The draft makes
 * both null on a directory, and a creation that sent them would be asking the
 * server to hold bytes for something that cannot hold any.
 */
export function buildNodeCreation(creation: NodeCreation): Partial<FileNode> {
  const created: Partial<FileNode> = { nodeType: creation.nodeType };

  if (creation.name !== undefined) created.name = creation.name;
  if (creation.parentId !== undefined) created.parentId = creation.parentId;

  if (creation.nodeType === "file") {
    if (creation.blobId !== undefined) created.blobId = creation.blobId;
    if (creation.type !== undefined) created.type = creation.type;
  }

  return created;
}

/**
 * The arguments of every `FileNode/set` this server emits.
 *
 * The two flags are written on each call, including the ones that destroy
 * nothing: a default is not a guarantee, and an argument left out is an argument
 * no test can see. `onExists` is never overridden — `null` is `Reject`, and
 * anything else would let a write destroy a sibling. `onDestroyRemoveChildren`
 * is overridden by `files_delete` alone, once the subtree has been counted and
 * the erasure confirmed.
 */
export function fileNodeSetArguments(
  accountId: Id,
  extra: Partial<Omit<FileNodeSetArguments, "accountId" | "onExists">> = {},
): FileNodeSetArguments {
  return {
    accountId,
    onDestroyRemoveChildren: false,
    ...extra,
    // Last, so no caller can pass it: this is the only value this server writes.
    onExists: null,
  };
}

/**
 * The folder a write is aimed at, read once per handler invocation.
 *
 * Read so a refusal can name a folder rather than echo an id back: "fn-7 does
 * not exist" tells nobody which folder they meant. `null` is the top level,
 * which is not a node and needs no read.
 */
export async function resolveParent(
  parentId: Id | null | undefined,
  context: ToolContext,
): Promise<FileNode | undefined> {
  if (parentId === null || parentId === undefined) return undefined;

  const args: FileNodeGetArguments = {
    accountId: context.session.accountId,
    ids: [parentId],
    properties: [...NODE_PROPERTIES],
  };

  const response = await context.once(`files:parent:${parentId}`, () =>
    context.client.request<GetResponse<FileNode>>(
      [CAPABILITY_CORE, CAPABILITY_FILENODE],
      ["FileNode/get", args, "0"],
    ),
  );

  return response.list.find((node) => node.id === parentId);
}

/**
 * A `SetError` turned into something the caller can act on.
 *
 * The terse rendering in `node.ts` serves a table cell, where one line per id is
 * all there is room for. This one serves the branches that write a single node,
 * where the refusal is the whole answer and a code on its own leaves the caller
 * with nowhere to go. Four of them have a way out worth naming; the rest fall
 * back to what the server said.
 */
export function explainSetError(error: SetError): string {
  const said = error.description === undefined ? "" : ` The server said: ${error.description}`;

  switch (error.type) {
    case "alreadyExists":
      return (
        "Refused by the server: a node of that name is already there. This server never replaces " +
        "one, because replacing is destroying: delete the existing node with files_delete, or " +
        `write under another name.${said}`
      );
    case "nodeHasChildren":
      return (
        "Refused by the server: the folder still holds something, and this call was not allowed " +
        `to take it along. Empty it first, or delete the folder with files_delete.${said}`
      );
    case "invalidProperties":
      return (
        "Refused by the server: one of the properties written is not acceptable, most often the " +
        `name or the parent folder.${said}`
      );
    case "overQuota":
      return (
        "Refused by the server: the account has no room left for this. Delete something with " +
        `files_delete, or ask for more quota.${said}`
      );
    default:
      return `Refused by the server: ${error.type}.${said}`;
  }
}

/**
 * Two patches where one is the prefix of the other are invalid (RFC 8620 §5.3).
 *
 * Caught here rather than on the wire, as in the contacts module: the server
 * would answer `invalidPatch` and write nothing, which is safe but says nothing
 * about which two parts of the request contradict each other.
 */
function refusePrefixCollision(patch: NodePatch): void {
  const keys = Object.keys(patch);

  for (const key of keys) {
    const nested = keys.find((other) => other.startsWith(`${key}/`));
    if (nested !== undefined) {
      throw new Error(
        `files: the patch would carry both ${key} and ${nested}, and a patch that is the prefix ` +
          "of another is invalid. Replacing a property and amending it in the same call cannot " +
          "both be honoured — do one or the other.",
      );
    }
  }
}
