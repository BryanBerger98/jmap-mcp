import { basename } from "node:path";
import { z } from "zod";
import type { Id, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_FILENODE } from "../../jmap/types/core.js";
import type { FileNode } from "../../jmap/types/filenode.js";
import { defineTool, type ToolContext, type ToolResult } from "../../registry/define-tool.js";
import { refuseOversizedBatch } from "../../shared/batch.js";
import { renderFields } from "../../shared/render.js";
import {
  buildNodeCreation,
  buildNodePatch,
  CREATION_KEY,
  explainSetError,
  FILE_NODES,
  fileNodeSetArguments,
  resolveParent,
} from "./edit.js";
import {
  type LocalPath,
  MISSING_ROOT_REFUSAL,
  maxUploadSize,
  readLocalFile,
  refuseUnusableRoot,
  resolveWithinRoot,
  statLocalFile,
} from "./local.js";
import { mimeTypeFor, refuseInvalidName } from "./name.js";
import {
  describeNodeOutcome,
  describeNodes,
  formatSize,
  isDirectory,
  resolveNodes,
} from "./node.js";

/**
 * The one schema of this module on `z.object` rather than `z.strictObject`.
 *
 * Stripping is the point. A caller that names `onExists` or
 * `onDestroyRemoveChildren` has the key dropped here and never sees it reach the
 * request, `fileNodeSetArguments` writing both itself. Refusing the call instead
 * would turn a key this server ignores into an error the caller must work
 * around, and the strictness would guard nothing the factory does not already.
 */
const inputSchema = z
  .object({
    action: z
      .enum(["upload", "create-folder", "organize"])
      .describe(
        "What to do: deposit a local file into the account, create a folder, or rename and move " +
          "nodes that are already there.",
      ),
    path: z
      .string()
      .optional()
      .describe(
        "The local file to deposit, absolute or relative to the configured directory. Required on " +
          "upload, and read only inside that directory.",
      ),
    ids: z
      .array(z.string())
      .optional()
      .describe("The nodes to rename or move, as files_browse returns them. Required on organize."),
    name: z
      .string()
      .optional()
      .describe(
        "The name to give. Required on create-folder. On upload it defaults to the local file " +
          "name. On organize it renames, and one name cannot be shared by several nodes.",
      ),
    parentId: z
      .string()
      .nullable()
      .optional()
      .describe("The folder to put the node in, or null for the top level."),
  })
  .refine((input) => input.action !== "upload" || input.path !== undefined, {
    message: "Name the local file to deposit with `path`.",
    path: ["path"],
  })
  .refine((input) => input.action !== "create-folder" || input.name !== undefined, {
    message: "Give the folder a `name`.",
    path: ["name"],
  })
  .refine((input) => input.action !== "organize" || input.ids !== undefined, {
    message: "Name the nodes to organize with `ids`.",
    path: ["ids"],
  });

type Input = z.infer<typeof inputSchema>;

export const filesWrite = defineTool({
  name: "files_write",
  title: "Deposit, create or organize files",
  description:
    "Writes to the file storage of the account: deposits a local file, creates a folder, or " +
    "renames and moves nodes that are already there. " +
    "Nothing here ever replaces or removes anything: a name already taken is refused rather than " +
    "overwritten, and deleting goes through files_delete, which asks first. " +
    "A deposit reads the local file only from inside the directory this server was configured " +
    "with, and the bytes travel from that file, never through this conversation. " +
    "Run files_browse first: every id this takes comes from there.",
  inputSchema,
  // None of the three actions can lose anything: `onExists` is written null on
  // every call, so a name already taken is refused rather than replaced.
  classes: ["draft"],
  classify: () => "draft",
  summarize: async (input, context) => {
    const where = await parentName(input.parentId, context);

    switch (input.action) {
      case "upload":
        return `Deposit ${input.path} into ${where} as ${uploadName(input)}.`;
      case "create-folder":
        return `Create the folder ${input.name} in ${where}.`;
      default: {
        const ids = input.ids ?? [];
        const named = describeNodes(await resolveNodes(ids, context), ids.length);
        return `${organizeAction(input).imperative} ${named}${input.parentId === undefined ? "" : ` into ${where}`}.`;
      }
    }
  },
  precheck: async (input, context) => {
    const named = input.action === "upload" ? uploadName(input) : input.name;
    if (named !== undefined) {
      const invalid = refuseInvalidName(named);
      if (invalid !== undefined) return invalid;
    }

    if (input.action === "organize") {
      const unusable = refuseUnusableBatch(input);
      if (unusable !== undefined) return unusable;
    }

    if (input.action === "upload") {
      const unusable = await refuseUnusableSource(input, context);
      if (unusable !== undefined) return unusable;
    }

    return refuseUnusableParent(input, context);
  },
  // Only `organize` counts anything: a deposit and a folder are one object each,
  // whatever else the call carries.
  confirmWhen: (input, context) => {
    const count = input.action === "organize" ? (input.ids ?? []).length : 0;

    return Promise.resolve(
      count > context.bulkConfirmAbove
        ? `This ${organizeAction(input).present} ${count} file nodes at once, past the ` +
            `${context.bulkConfirmAbove} this server writes without asking.`
        : undefined,
    );
  },
  run: async (input, context) => {
    switch (input.action) {
      case "upload":
        return runUpload(input, context);
      case "create-folder":
        return runCreateFolder(input, context);
      default:
        return runOrganize(input, context);
    }
  },
});

/**
 * Deposits a local file: bytes first, then the node that points at them.
 *
 * The two steps are sequential and cannot be otherwise — a `FileNode/set` naming
 * a blob that has not been uploaded references nothing. Every check the
 * `precheck` already made is made again here, for the reason `mail_move` and the
 * recipient perimeter carry: a hook that swallowed a failed read must not have
 * the last word on what gets written.
 */
async function runUpload(input: Input, context: ToolContext): Promise<ToolResult> {
  const { localRoot } = context.files;
  if (localRoot === undefined) return { text: MISSING_ROOT_REFUSAL };

  // Repeated from the `precheck`: a root that went missing in between would
  // otherwise be reported as a missing source file, blaming the wrong thing.
  const unusableRoot = await refuseUnusableRoot(localRoot);
  if (unusableRoot !== undefined) return { text: unusableRoot };

  const path = demand(input.path, "path");
  const source = await resolveWithinRoot(path, localRoot);
  if (!source.ok) return { text: source.refusal };

  const unusable = await refuseUnreadableSource(source, context);
  if (unusable !== undefined) return { text: unusable };

  // Taken from the path as given, never from `source.path`: that one is the
  // realpath, so a symlink would be deposited under the name of its target.
  const name = input.name ?? basename(path);
  const invalid = refuseInvalidName(name);
  if (invalid !== undefined) return { text: invalid };

  const read = await readLocalFile(source.path);
  if (!read.ok) return { text: read.refusal };

  const type = mimeTypeFor(name);
  const blob = await context.blobs.upload(read.bytes, type);

  const response = await setNodes(context, {
    create: {
      [CREATION_KEY]: buildNodeCreation({
        nodeType: "file",
        name,
        parentId: input.parentId,
        blobId: blob.blobId,
        type,
      }),
    },
  });

  const text = describeCreation(response, {
    what: `File ${name}`,
    extra: {
      size: `${read.bytes.byteLength} bytes (${formatSize(read.bytes.byteLength)})`,
      mime: type,
      from: source.path,
    },
    folder: await parentName(input.parentId, context),
  });

  // Said here and not in `explainSetError`, which also serves create-folder and
  // organize: those move no bytes. The two steps cannot be reordered — a node
  // naming a blob that was never uploaded references nothing — so a refused
  // creation always leaves the transfer behind it, and the caller should hear it
  // from the answer rather than from their quota.
  if (response.notCreated?.[CREATION_KEY] === undefined) return { text };

  return {
    text:
      `${text}\n\nThe bytes were already transferred before this refusal: the server holds them ` +
      "unreferenced, and no tool here can remove them.",
  };
}

/** Creates a folder: a node with no bytes, and nothing to upload first. */
async function runCreateFolder(input: Input, context: ToolContext): Promise<ToolResult> {
  const name = demand(input.name, "name");
  const invalid = refuseInvalidName(name);
  if (invalid !== undefined) return { text: invalid };

  const response = await setNodes(context, {
    create: {
      [CREATION_KEY]: buildNodeCreation({
        nodeType: "directory",
        name,
        parentId: input.parentId,
      }),
    },
  });

  return {
    text: describeCreation(response, {
      what: `Folder ${name}`,
      extra: {},
      folder: await parentName(input.parentId, context),
    }),
  };
}

/** Renames or moves nodes that already exist: one patch, applied to each id. */
async function runOrganize(input: Input, context: ToolContext): Promise<ToolResult> {
  const ids = input.ids ?? [];

  const unusable = refuseUnusableBatch(input);
  if (unusable !== undefined) return { text: unusable };

  if (input.name !== undefined) {
    const invalid = refuseInvalidName(input.name);
    if (invalid !== undefined) return { text: invalid };
  }

  // One patch object, shared by every id: the edit is the same for all of them,
  // and a name is only in it when a single node is being renamed.
  const patch = buildNodePatch({ name: input.name, parentId: input.parentId });
  const response = await setNodes(context, {
    update: Object.fromEntries(ids.map((id) => [id, patch])),
  });

  return { text: describeNodeOutcome(response, ids, organizeVerb(input).toLowerCase()) };
}

/**
 * The one place this module reaches the server.
 *
 * Every call goes through `fileNodeSetArguments`, so `onExists` is `null` and
 * `onDestroyRemoveChildren` is false on all of them — including the ones that
 * create, where neither flag has anything to act on.
 */
function setNodes(
  context: ToolContext,
  extra: { create?: Record<Id, Partial<FileNode>>; update?: Record<Id, Record<string, unknown>> },
): Promise<SetResponse<FileNode>> {
  return context.client.request<SetResponse<FileNode>>(
    [CAPABILITY_CORE, CAPABILITY_FILENODE],
    [
      "FileNode/set",
      // The flags are left to the factory rather than repeated here: two writers
      // of the same key is how one of them ends up saying something else.
      fileNodeSetArguments(context.session.accountId, extra),
      "0",
    ],
  );
}

/** What a creation came to, in the caller's terms rather than the server's. */
function describeCreation(
  response: SetResponse<FileNode>,
  said: { what: string; extra: Record<string, unknown>; folder: string },
): string {
  const refused = response.notCreated?.[CREATION_KEY];
  if (refused !== undefined) return explainSetError(refused);

  const created = response.created?.[CREATION_KEY];

  return renderFields({
    created: `${said.what} created in ${said.folder}`,
    id: created?.id,
    ...said.extra,
  });
}

/**
 * What an organize call cannot be asked to do.
 *
 * A name shared by several nodes is the one worth spelling out: the server would
 * accept it and leave a folder holding three files of the same name, which every
 * listing then shows as one thing three times.
 */
function refuseUnusableBatch(input: Input): string | undefined {
  const ids = input.ids ?? [];

  const oversized = refuseOversizedBatch(ids, FILE_NODES);
  if (oversized !== undefined) return oversized;

  if (input.name !== undefined && ids.length > 1) {
    return (
      `Refused: one name was given for ${ids.length} file nodes, and a name cannot be shared. ` +
      "Rename them one call at a time, or drop `name` and only move them."
    );
  }

  if (input.name === undefined && input.parentId === undefined) {
    return (
      "Refused: neither a name nor a parent folder was given, so there is nothing to change. " +
      "Pass `name` to rename, `parentId` to move, or both."
    );
  }

  return undefined;
}

/** The local file a deposit reads: it must be configured, inside the root, and a file. */
async function refuseUnusableSource(
  input: Input,
  context: ToolContext,
): Promise<string | undefined> {
  // The narrowing below is the check: it answers an unnamed root with the same
  // sentence a helper would, and hands `resolveWithinRoot` the `string` it needs.
  const { localRoot } = context.files;
  if (localRoot === undefined) return MISSING_ROOT_REFUSAL;

  const unusableRoot = await refuseUnusableRoot(localRoot);
  if (unusableRoot !== undefined) return unusableRoot;

  const source = await resolveWithinRoot(demand(input.path, "path"), localRoot);
  if (!source.ok) return source.refusal;

  return refuseUnreadableSource(source, context);
}

/**
 * Existence, kind and size, checked before a byte moves.
 *
 * The ceiling is the session's own `maxSizeUpload`, and it is quoted in the
 * refusal: a transfer that the server would cut off halfway is worth refusing
 * with a number rather than with a failure.
 */
async function refuseUnreadableSource(
  source: LocalPath & { ok: true },
  context: ToolContext,
): Promise<string | undefined> {
  const entry = await statLocalFile(source.path);

  if (entry.kind === "missing") {
    return `Refused: there is no file at ${source.path}, so there is nothing to deposit.`;
  }
  if (entry.kind === "unreadable") {
    // Said apart from an absence on purpose: the file is there, and telling the
    // caller it is not would send them hunting instead of fixing a permission.
    return (
      `Refused: ${source.path} could not be examined — ${entry.reason}. Nothing was transferred. ` +
      "Check the permissions on the file and on the directories above it."
    );
  }
  if (entry.kind === "directory") {
    return (
      `Refused: ${source.path} is a directory, and this server deposits one file per call. ` +
      "Create the folder with action create-folder, then deposit the files into it."
    );
  }

  const ceiling = maxUploadSize(context.session);
  if (ceiling !== undefined && entry.size > ceiling) {
    return (
      `Refused: ${source.path} is ${formatSize(entry.size)} and this server accepts at most ` +
      `${formatSize(ceiling)} per upload (${ceiling} bytes, as the session advertises it). ` +
      "Nothing was transferred."
    );
  }

  return undefined;
}

/**
 * The folder a write is aimed at, when the call names one.
 *
 * Read before the write so the refusal names the node: the server would answer
 * `invalidProperties` with no description, which leaves the caller guessing
 * whether the id is unknown or simply not a folder.
 */
async function refuseUnusableParent(
  input: Input,
  context: ToolContext,
): Promise<string | undefined> {
  if (input.parentId === null || input.parentId === undefined) return undefined;

  const parent = await resolveParent(input.parentId, context);
  if (parent === undefined) {
    return (
      `Refused: no file node has the id ${input.parentId}, so nothing can be put in it. ` +
      "Run files_browse to list the folders the account holds."
    );
  }

  return isDirectory(parent)
    ? undefined
    : `Refused: ${describeNodes([parent])} is a file, not a folder, so nothing can be put inside it.`;
}

/** The name a deposit gives the node: the one asked for, or the local file's. */
function uploadName(input: Input): string | undefined {
  return input.name ?? (input.path === undefined ? undefined : basename(input.path));
}

/**
 * What an organize call is about to do, said before it has done it.
 *
 * Kept apart from `organizeVerb` rather than derived from it: a summary and a
 * confirmation are read while nothing has happened yet, and a past participle
 * there tells the user the thing is done at the exact moment they are deciding
 * whether it should be. The two forms are the two grammars that reading needs —
 * `Rename and move 30 file nodes.` above, `This renames and moves 30 file nodes`
 * inside the sentence.
 */
function organizeAction(input: Input): { imperative: string; present: string } {
  if (input.name !== undefined && input.parentId !== undefined) {
    return { imperative: "Rename and move", present: "renames and moves" };
  }
  return input.name === undefined
    ? { imperative: "Move", present: "moves" }
    : { imperative: "Rename", present: "renames" };
}

/** What an organize call did, in one word, for an outcome line written after it. */
function organizeVerb(input: Input): string {
  if (input.name !== undefined && input.parentId !== undefined) return "Renamed and moved";
  return input.name === undefined ? "Moved" : "Renamed";
}

async function parentName(parentId: Id | null | undefined, context: ToolContext): Promise<string> {
  if (parentId === null || parentId === undefined) return "the top level";

  const parent = await resolveParent(parentId, context);
  return parent === undefined ? parentId : `${parent.name ?? "(unnamed)"} (${parent.id})`;
}

/**
 * The field this action cannot run without, or a throw.
 *
 * `inputSchema` refuses a call that omits it before the handler is reached, so
 * an absent value here means the schema and the code below it have drifted
 * apart. A fallback would answer that drift by uploading nothing under an empty
 * name; a throw writes nothing at all.
 */
function demand<T>(value: T | undefined, field: string): T {
  if (value === undefined) {
    throw new Error(`files_write: \`${field}\` is missing, which the input schema rules out.`);
  }
  return value;
}
