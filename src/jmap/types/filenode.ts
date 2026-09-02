/**
 * draft-ietf-jmap-filenode-14 — moving target; Stalwart README lags, the code arbitrates.
 *
 * Three rules are load-bearing here, and each of them is enforced by what this
 * file refuses to make representable rather than by a check somewhere else:
 *
 * - **The conditions are a closed list.** `FileNode/query` parses twenty-two
 *   conditions and executes nine. The other thirteen fall into an empty match arm
 *   (`file/query.rs:159-177`) with no error and no warning, so a filter that names
 *   one returns more nodes than it asked for. Only the nine that run are declared.
 * - **The sort is a closed list.** An unsupported comparator is not rejected as
 *   `UnsupportedSort`: it is dropped from the list (`file/query.rs:213-226`), and a
 *   list emptied that way falls back to document order. Only `name`, `size` and
 *   `nodeType` survive, so only those three are declared.
 * - **`onExists` is always written.** It is optional in the draft and defaults to
 *   `Reject` on the server; a default is not a guarantee. Made mandatory here so a
 *   `FileNode/set` that forgets it does not compile.
 */

import type { Id } from "./core.js";

/**
 * The node types this server offers.
 *
 * The draft has a third, `symlink`. Stalwart parses it and returns an empty set
 * for it, so offering it would promise a search that can only ever come back
 * empty.
 */
export const NODE_TYPES = ["file", "directory"] as const;

export type NodeType = (typeof NODE_TYPES)[number];

/** What the account may do to one node, as the server computes it. */
export interface FilesRights {
  mayRead: boolean;
  mayAddChildren: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  mayModifyContent: boolean;
  mayShare: boolean;
}

/**
 * A node of the file tree: a file or a directory.
 *
 * `blobId`, `size` and `type` are null on a directory — the draft requires it,
 * and every rendering has to survive their absence rather than print a zero size
 * or an invented MIME type.
 */
export interface FileNode {
  id: Id;
  /** Null at the top level; the draft carries no root node to point at. */
  parentId?: Id | null;
  nodeType?: NodeType;
  blobId?: Id | null;
  size?: number | null;
  name?: string;
  type?: string | null;
  created?: string;
  modified?: string;
  changed?: string;
  executable?: boolean;
  role?: string | null;
  myRights?: FilesRights;
}

/**
 * The nine conditions `FileNode/query` actually executes.
 *
 * Adding a tenth here would compile and would then lie: see the header.
 */
export interface FileNodeFilterCondition {
  parentId?: Id;
  ancestorId?: Id;
  descendantId?: Id;
  isTopLevel?: boolean;
  nodeType?: NodeType;
  name?: string;
  nameMatch?: string;
  minSize?: number;
  maxSize?: number;
}

/** The three sortable properties. No date sort is representable. */
export type FileNodeComparatorProperty = "name" | "size" | "nodeType";

export interface FileNodeComparator {
  property: FileNodeComparatorProperty;
  isAscending: boolean;
}

export type FileNodeGetArguments = {
  accountId: Id;
  ids?: Id[] | null;
  properties?: string[] | null;
};

export type FileNodeQueryArguments = {
  accountId: Id;
  filter?: FileNodeFilterCondition;
  sort?: FileNodeComparator[];
  position?: number;
  limit?: number;
  calculateTotal?: boolean;
};

/**
 * A patch, as RFC 8620 §5.3 defines it: keys are JSON pointers into the object.
 *
 * Not a `Partial<FileNode>`, for the reason the contacts module already carries:
 * a partial object sent under a name that reads like a correction replaces
 * everything the server does not see.
 */
export type NodePatch = Record<string, unknown>;

/**
 * What the server does when a sibling already holds the name being written.
 *
 * Four values, and the wire spellings are exactly these (`file_node.rs:320-336`):
 * `null` and `""` both mean `Reject`, the server-side default. `replace`
 * destroys the existing node outright (`file/set.rs`, `implicit_destroys`);
 * `newest` resolves to `replace` when the incoming node is more recent, so it
 * destroys conditionally; `rename` and `Reject` never destroy anything.
 *
 * This server writes `null` on every call. Replacing a file is a destruction,
 * and a destruction goes through `files_delete`, where it is confirmed.
 */
export type OnExists = null | "replace" | "rename" | "newest";

export type FileNodeSetArguments = {
  accountId: Id;
  create?: Record<Id, Partial<FileNode>>;
  update?: Record<Id, NodePatch>;
  destroy?: Id[];
  /**
   * Required by this type, optional in the draft.
   *
   * True destroys a whole subtree in one call. Unlike the mailbox and address
   * book flags, which are always false, this one may be true — but only when it
   * was asked for explicitly and confirmed, the subtree having been counted
   * first.
   */
  onDestroyRemoveChildren: boolean;
  /** Required by this type, optional in the draft. Always `null` here. */
  onExists: OnExists;
};
