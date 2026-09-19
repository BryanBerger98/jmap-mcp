import { gunzipSync } from "node:zlib";
import { unzipSync } from "fflate";
import { z } from "zod";
import { MAX_DOWNLOAD_SIZE_KEY, maxDownloadSize } from "../../config/schema.js";
import type { GetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_MAIL } from "../../jmap/types/core.js";
import type { Email, EmailBodyPart, EmailGetArguments } from "../../jmap/types/mail.js";
import { defineTool } from "../../registry/define-tool.js";
import { formatSize, renderFields } from "../../shared/render.js";
import { MAX_BODY_VALUE_BYTES } from "./read.js";

/**
 * The default ceiling on decoded output, in bytes.
 *
 * Reuses `mail_read`'s own default rather than inventing a second number: both
 * bound one tool call's worth of text handed back to the model, for the same
 * reason. `maxBytes` lowers it or raises it, up to `files.maxDownloadSize`.
 */
const DEFAULT_ATTACHMENT_TEXT_BYTES = MAX_BODY_VALUE_BYTES;

/** What an attachment is downloaded as when the server declares no type. */
const FALLBACK_MIME = "application/octet-stream";

/** Only what selecting and downloading one attachment reads. */
const MESSAGE_PROPERTIES = ["id", "attachments"] as const;
const BODY_PROPERTIES = ["partId", "blobId", "type", "charset", "size", "name"] as const;

const inputSchema = z.object({
  messageId: z.string().describe("Message id, as mail_search or mail_read returns it."),
  blobId: z
    .string()
    .describe("Attachment blobId, from the attachments table mail_read prints for this message."),
  decode: z
    .enum(["auto", "raw"])
    .optional()
    .describe(
      '"auto" (default) inflates a gzip attachment and unpacks a zip one, and returns a plain-text, ' +
        'XML or JSON attachment as-is; anything else falls back to base64. "raw" always returns base64.',
    ),
  maxBytes: z
    .number()
    .int()
    .min(200)
    .optional()
    .describe(
      `Bytes of decoded output to keep, ${DEFAULT_ATTACHMENT_TEXT_BYTES} by default. Bounded by ` +
        `${MAX_DOWNLOAD_SIZE_KEY}, the same ceiling that refuses the download itself.`,
    ),
});

export const mailAttachmentFetch = defineTool({
  name: "mail_attachment_fetch",
  title: "Fetch a mail attachment",
  description:
    "Downloads one attachment of one message and returns its content in the reply. Run mail_read " +
    "first to list a message's attachments and read the blobId this tool takes. The attachment's " +
    `declared size is checked before any byte moves, and refused past ${MAX_DOWNLOAD_SIZE_KEY}. ` +
    `Decoded output is cut at maxBytes (${DEFAULT_ATTACHMENT_TEXT_BYTES} bytes by default) and the ` +
    "cut is announced in the output, the same convention as mail_read.",
  inputSchema,
  classes: ["read"],
  classify: () => "read",
  summarize: (input) => `Fetch attachment ${input.blobId} of message ${input.messageId}.`,
  run: async (input, context) => {
    const args: EmailGetArguments = {
      accountId: context.session.accountId,
      ids: [input.messageId],
      properties: [...MESSAGE_PROPERTIES],
      bodyProperties: [...BODY_PROPERTIES],
    };

    const response = await context.client.request<GetResponse<Email>>(
      [CAPABILITY_CORE, CAPABILITY_MAIL],
      ["Email/get", args, "0"],
    );

    const email = response.list[0];
    if (email === undefined) {
      return {
        text: `Refused: no message has the id ${input.messageId}. Run mail_search or mail_read first to find one.`,
      };
    }

    const attachment = (email.attachments ?? []).find((part) => part.blobId === input.blobId);
    if (attachment === undefined) {
      return {
        text:
          `Refused: message ${input.messageId} carries no attachment with blobId ${input.blobId}. ` +
          "Run mail_read on this message to list its attachments.",
      };
    }

    // Checked before the transfer, exactly as `files_fetch` checks a node's
    // declared size: the whole attachment is held in memory before any decode
    // sees a byte of it, and the server already stated the size in the answer
    // that named the blobId.
    const ceiling = maxDownloadSize(context.files);
    if (attachment.size > ceiling) {
      return {
        text:
          `Refused: ${describeAttachment(attachment.name, input.blobId)} is ${formatSize(attachment.size)} ` +
          `and this server fetches at most ${formatSize(ceiling)} per attachment (${ceiling} bytes). ` +
          `Nothing was transferred. Raise ${MAX_DOWNLOAD_SIZE_KEY} in your configuration to fetch it.`,
      };
    }

    const bytes = await context.blobs.download(
      input.blobId,
      attachment.name ?? input.blobId,
      attachment.type || FALLBACK_MIME,
    );

    // A second, independent ceiling from the transfer guard above: a `.zip` or
    // `.gz` attachment can decode to far more bytes than it was downloaded as,
    // and the cut on the way out must hold whatever the cut on the way in did.
    const maxBytes = Math.min(input.maxBytes ?? DEFAULT_ATTACHMENT_TEXT_BYTES, ceiling);
    const decoded =
      input.decode === "raw" ? decodeRaw(bytes, maxBytes) : decodeAuto(bytes, attachment, maxBytes);

    const notes = [
      decoded.note,
      decoded.isTruncated ? truncationNote(maxBytes, ceiling) : undefined,
    ].filter((note): note is string => note !== undefined);
    const footer = notes.length > 0 ? `\n\n[${notes.join(" — ")}]` : "";

    return {
      text: `${renderFields({
        message: input.messageId,
        attachment: attachment.name ?? input.blobId,
        type: attachment.type,
        size: `${bytes.byteLength} bytes (${formatSize(bytes.byteLength)})`,
      })}\n\n${decoded.text}${footer}`,
    };
  },
});

/** A refusal names the attachment by name when it has one, by blobId otherwise. */
function describeAttachment(name: string | null, blobId: string): string {
  return name === null || name === "" ? `blobId ${blobId}` : `"${name}"`;
}

/**
 * `maxBytes` only lowers or raises the ceiling within `files.maxDownloadSize`,
 * so inviting the caller to raise it is only sound below that ceiling. At the
 * ceiling the same advice buys a wasted round trip: the way past it is the
 * configuration, not the argument.
 */
function truncationNote(maxBytes: number, ceiling: number): string {
  return maxBytes < ceiling
    ? `output cut at ${maxBytes} bytes; ask for the rest by raising maxBytes, up to ${ceiling}`
    : `output cut at ${maxBytes} bytes, the ${MAX_DOWNLOAD_SIZE_KEY} ceiling; raise it in your configuration to see more`;
}

interface DecodedOutput {
  text: string;
  isTruncated: boolean;
  /** Set when the text is not the attachment's own bytes, verbatim. */
  note?: string;
}

/** `decode: "raw"` — base64, always, whatever the attachment declares itself as. */
function decodeRaw(bytes: Uint8Array, maxBytes: number): DecodedOutput {
  return cutBase64(bytes, maxBytes);
}

/**
 * `decode: "auto"` (the default) — readable text wherever the attachment
 * allows it, base64 only where it does not.
 */
function decodeAuto(bytes: Uint8Array, attachment: EmailBodyPart, maxBytes: number): DecodedOutput {
  if (isGzip(attachment)) {
    try {
      return { ...cutBytes(gunzipSync(bytes), maxBytes), note: "gunzipped" };
    } catch (error) {
      return {
        ...cutBase64(bytes, maxBytes),
        note: `could not be gunzipped (${describeError(error)}), shown as base64`,
      };
    }
  }

  if (isZip(attachment)) {
    try {
      return decodeZip(bytes, maxBytes);
    } catch (error) {
      return {
        ...cutBase64(bytes, maxBytes),
        note: `could not be unzipped (${describeError(error)}), shown as base64`,
      };
    }
  }

  if (isTextLike(attachment.type)) {
    return cutBytes(bytes, maxBytes);
  }

  return { ...cutBase64(bytes, maxBytes), note: "binary content, shown as base64" };
}

function isGzip(attachment: EmailBodyPart): boolean {
  return attachment.type === "application/gzip" || nameEndsWith(attachment.name, ".gz");
}

function isZip(attachment: EmailBodyPart): boolean {
  return attachment.type === "application/zip" || nameEndsWith(attachment.name, ".zip");
}

function nameEndsWith(name: string | null, suffix: string): boolean {
  return name?.toLowerCase().endsWith(suffix) ?? false;
}

function isTextLike(type: string): boolean {
  return type.startsWith("text/") || type === "application/xml" || type === "application/json";
}

/**
 * Unpacks a zip archive: the one entry's bytes when it holds one, every entry
 * prefixed by its name when it holds several — never a silent pick among them.
 */
function decodeZip(bytes: Uint8Array, maxBytes: number): DecodedOutput {
  const entries = unzipSync(bytes);
  const names = Object.keys(entries);

  if (names.length === 0) {
    return { text: "(the zip archive is empty)", isTruncated: false };
  }

  if (names.length === 1) {
    const [name] = names as [string];
    return { ...cutBytes(entries[name] as Uint8Array, maxBytes), note: `unzipped from ${name}` };
  }

  const chunks: Uint8Array[] = [];
  names.forEach((name, index) => {
    if (index > 0) chunks.push(TWO_NEWLINES);
    chunks.push(new TextEncoder().encode(`== ${name} ==\n`));
    chunks.push(entries[name] as Uint8Array);
  });

  return { ...cutBytes(concatBytes(chunks), maxBytes), note: `unzipped, ${names.length} entries` };
}

const TWO_NEWLINES = new TextEncoder().encode("\n\n");

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/**
 * Cuts at a byte boundary, then decodes: cutting the decoded string instead
 * would count UTF-16 code units, not the bytes `maxBytes` promises. A cut that
 * lands inside a multi-byte character is not re-checked — `TextDecoder`
 * replaces the broken tail with a single U+FFFD, same as a truncated emoji
 * anywhere else in this server's output.
 */
function cutBytes(bytes: Uint8Array, maxBytes: number): { text: string; isTruncated: boolean } {
  if (bytes.byteLength <= maxBytes) {
    return { text: new TextDecoder().decode(bytes), isTruncated: false };
  }
  return { text: new TextDecoder().decode(bytes.subarray(0, maxBytes)), isTruncated: true };
}

/** Base64 is ASCII, so a character count is a byte count and the cut needs no decoder. */
function cutBase64(bytes: Uint8Array, maxBytes: number): { text: string; isTruncated: boolean } {
  const full = Buffer.from(bytes).toString("base64");
  return full.length <= maxBytes
    ? { text: full, isTruncated: false }
    : { text: full.slice(0, maxBytes), isTruncated: true };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
