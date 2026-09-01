import { z } from "zod";
import { defineTool } from "../../registry/define-tool.js";
import { renderFields } from "../../shared/render.js";
import {
  MISSING_ROOT_REFUSAL,
  refuseMissingRoot,
  resolveWithinRoot,
  statLocalFile,
  writeWithoutOverwrite,
} from "./local.js";
import { describeNodes, formatSize, isDirectory, resolveNodes } from "./node.js";

/** What a download is called when the node names neither a type nor a name. */
const FALLBACK_TYPE = "application/octet-stream";

const inputSchema = z.strictObject({
  id: z
    .string()
    .describe("Id of a file node, as files_browse returns it. A folder carries no bytes."),
  saveAs: z
    .string()
    .optional()
    .describe(
      "Name, or path relative to the configured local directory, to write the file at. " +
        "Defaults to the name the node carries. An existing file is never overwritten.",
    ),
});

export const filesFetch = defineTool({
  name: "files_fetch",
  title: "Fetch a file",
  description:
    "Downloads one file from the account and writes it to the local directory this server was " +
    "configured with, then answers with the path it wrote, the size and the MIME type. " +
    "The bytes never travel through this conversation: there is no excerpt, no preview and no " +
    "base64 in the answer, whatever the file is. Open the path to see the content. " +
    "Only paths under the configured directory are writable, and an existing file is never " +
    "overwritten: pass saveAs with another name instead.",
  inputSchema,
  classes: ["read"],
  classify: () => "read",
  summarize: (input) => `Fetch file node ${input.id} to the local directory.`,
  // Asked before anything else: a fetch with nowhere to write is refused whatever
  // the node turns out to be, and reading it first would spend a round trip on a
  // call that was already lost.
  precheck: (_input, context) => refuseMissingRoot(context.files),
  run: async (input, context) => {
    const { localRoot } = context.files;
    if (localRoot === undefined) {
      // Unreachable through the registry, which ran `precheck` first. Kept
      // because `run` cannot narrow the option from a check made elsewhere, and
      // an absent root must never reach the resolver.
      return { text: MISSING_ROOT_REFUSAL };
    }

    const [node] = await resolveNodes([input.id], context);
    if (node === undefined) {
      return {
        text: `Refused: no file node has the id ${input.id}. Run files_browse to list what the account holds.`,
      };
    }

    const named = describeNodes([node]);
    if (isDirectory(node)) {
      return {
        text:
          `Refused: ${named} is a folder, and a folder holds no bytes to fetch. Browse it with ` +
          "files_browse and fetch one of the files inside it.",
      };
    }

    const { blobId } = node;
    if (blobId === undefined || blobId === null) {
      return {
        text: `Refused: ${named} carries no blobId, so the server has no content to hand back for it.`,
      };
    }

    const destination = await resolveWithinRoot(input.saveAs ?? node.name ?? node.id, localRoot);
    if (!destination.ok) return { text: destination.refusal };

    // Checked before the transfer and again by the exclusive write below. The
    // first check is the courteous one — downloading megabytes only to refuse to
    // write them wastes the round trip; the second is the honest one, since
    // anything may land on that path in between.
    const occupied = await statLocalFile(destination.path);
    if (occupied.kind !== "missing") {
      return {
        text:
          `Refused: ${destination.path} already exists and this server never overwrites a local ` +
          "file. Pass saveAs with another name, or move the existing file aside.",
      };
    }

    const bytes = await context.blobs.download(
      blobId,
      node.name ?? node.id,
      node.type ?? FALLBACK_TYPE,
    );

    const failed = await writeWithoutOverwrite(destination.path, bytes);
    if (failed !== undefined) return { text: failed };

    return {
      text: renderFields({
        saved: destination.path,
        size: `${bytes.byteLength} bytes (${formatSize(bytes.byteLength)})`,
        mime: node.type,
        source: named,
      }),
    };
  },
});
