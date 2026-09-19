import { gunzipSync, unzipSync } from "fflate";
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
 * reason. `maxBytes` lowers it or raises it, up to `MAX_ATTACHMENT_TEXT_BYTES`.
 */
const DEFAULT_ATTACHMENT_TEXT_BYTES = MAX_BODY_VALUE_BYTES;

/**
 * The most decoded output one call returns, in bytes, whatever the download
 * ceiling allows.
 *
 * This tool reads text-like attachments into the conversation, where file
 * bytes otherwise never travel: a base64 excerpt is a hint of what a binary
 * attachment holds, never a way to carry it. The ceiling is fixed so no
 * configuration turns the reply into a transport for a whole file.
 */
const MAX_ATTACHMENT_TEXT_BYTES = 100_000;

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
        "XML or JSON attachment as-is; anything else, including archived content that is not UTF-8 " +
        'text, falls back to base64. "raw" always returns base64.',
    ),
  maxBytes: z
    .number()
    .int()
    .min(200)
    .max(MAX_ATTACHMENT_TEXT_BYTES)
    .optional()
    .describe(
      `Bytes of decoded output to keep, ${DEFAULT_ATTACHMENT_TEXT_BYTES} by default and ` +
        `${MAX_ATTACHMENT_TEXT_BYTES} at most.`,
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
    // and what reaches the conversation stays an excerpt whatever came in.
    const maxBytes = input.maxBytes ?? DEFAULT_ATTACHMENT_TEXT_BYTES;
    const decoded =
      input.decode === "raw"
        ? decodeRaw(bytes, maxBytes)
        : decodeAuto(bytes, attachment, maxBytes, ceiling);

    const notes = [decoded.note, decoded.isTruncated ? truncationNote(maxBytes) : undefined].filter(
      (note): note is string => note !== undefined,
    );
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
 * `maxBytes` only lowers or raises the cut within `MAX_ATTACHMENT_TEXT_BYTES`,
 * so inviting the caller to raise it is only sound below that ceiling. At the
 * ceiling the same advice buys a wasted round trip, and nothing moves it.
 */
function truncationNote(maxBytes: number): string {
  return maxBytes < MAX_ATTACHMENT_TEXT_BYTES
    ? `output cut at ${maxBytes} bytes; ask for more by raising maxBytes, up to ${MAX_ATTACHMENT_TEXT_BYTES}`
    : `output cut at ${maxBytes} bytes, the most this tool returns in one reply`;
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
function decodeAuto(
  bytes: Uint8Array,
  attachment: EmailBodyPart,
  maxBytes: number,
  ceiling: number,
): DecodedOutput {
  if (isGzip(attachment)) {
    try {
      // A fixed output buffer, one byte past the cut so the cut still shows:
      // the inflater stops writing where the buffer ends, so a small archive
      // that inflates to gigabytes never exists in memory beyond this prefix.
      const prefix = gunzipSync(bytes, { out: new Uint8Array(maxBytes + 1) });
      return isUtf8Text(prefix, maxBytes)
        ? { ...cutBytes(prefix, maxBytes), note: "gunzipped" }
        : { ...cutBase64(prefix, maxBytes), note: "gunzipped, binary content shown as base64" };
    } catch (error) {
      return {
        ...cutBase64(bytes, maxBytes),
        note: `could not be gunzipped (${describeError(error)}), shown as base64`,
      };
    }
  }

  if (isZip(attachment)) {
    try {
      return decodeZip(bytes, maxBytes, ceiling);
    } catch (error) {
      return {
        ...cutBase64(bytes, maxBytes),
        note: `could not be unzipped (${describeError(error)}), shown as base64`,
      };
    }
  }

  if (isTextLike(attachment.type)) {
    const { encoding, note } = encodingFor(attachment.charset);
    return { ...cutBytes(bytes, maxBytes, encoding), ...(note === undefined ? {} : { note }) };
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
 *
 * The unzipper allocates each entry at the size the archive declares for it,
 * so the declared sizes are what bound memory. An entry is unpacked only while
 * the running total stays within `ceiling`, the most this server already
 * agreed to hold for one attachment; an entry past it is skipped and named.
 * Once the total reaches `maxBytes`, later entries would land past the cut
 * anyway and are left packed.
 */
function decodeZip(bytes: Uint8Array, maxBytes: number, ceiling: number): DecodedOutput {
  let unpacked = 0;
  let isPastCut = false;
  const skipped: string[] = [];
  const entries = unzipSync(bytes, {
    filter: (file) => {
      if (unpacked >= maxBytes) {
        isPastCut = true;
        return false;
      }
      // A stored entry is copied at its compressed size, a deflated one
      // allocated at its original size: the larger of the two covers both.
      const size = Math.max(file.size, file.originalSize);
      if (unpacked + size > ceiling) {
        skipped.push(file.name);
        return false;
      }
      unpacked += size;
      return true;
    },
  });
  const names = Object.keys(entries);
  const skippedNote = describeSkipped(skipped, ceiling);

  if (names.length === 0) {
    return skippedNote === undefined
      ? { text: "(the zip archive is empty)", isTruncated: false }
      : {
          text: "(no entry of the zip archive was unpacked)",
          isTruncated: false,
          note: skippedNote,
        };
  }

  if (names.length === 1 && skipped.length === 0 && !isPastCut) {
    const [name] = names as [string];
    const entry = entries[name] as Uint8Array;
    return isUtf8Text(entry, maxBytes)
      ? { ...cutBytes(entry, maxBytes), note: `unzipped from ${name}` }
      : {
          ...cutBase64(entry, maxBytes),
          note: `unzipped from ${name}, binary content shown as base64`,
        };
  }

  // A binary entry is spliced in as base64, already cut: the whole output is
  // cut at `maxBytes` anyway, so no more of it could ever show.
  const binary: string[] = [];
  const chunks: Uint8Array[] = [];
  names.forEach((name, index) => {
    const entry = entries[name] as Uint8Array;
    const isText = isUtf8Text(entry, maxBytes);
    if (!isText) binary.push(name);
    if (index > 0) chunks.push(TWO_NEWLINES);
    chunks.push(new TextEncoder().encode(`== ${name}${isText ? "" : " (base64)"} ==\n`));
    chunks.push(isText ? entry : new TextEncoder().encode(cutBase64(entry, maxBytes).text));
  });
  const binaryNote =
    binary.length === 0 ? undefined : `binary entries shown as base64: ${listNames(binary)}`;

  const cut = cutBytes(concatBytes(chunks), maxBytes);
  return {
    text: cut.text,
    isTruncated: cut.isTruncated || isPastCut,
    note: [`unzipped, ${names.length} entries`, binaryNote, skippedNote]
      .filter((part): part is string => part !== undefined)
      .join("; "),
  };
}

/** How many entry names a note lists before it only counts the rest. */
const ENTRY_NAMES_SHOWN = 5;

function listNames(names: string[]): string {
  const shown = names.slice(0, ENTRY_NAMES_SHOWN).join(", ");
  const rest = names.length - ENTRY_NAMES_SHOWN;
  return rest > 0 ? `${shown}, and ${rest} more` : shown;
}

function describeSkipped(skipped: string[], ceiling: number): string | undefined {
  if (skipped.length === 0) return undefined;
  const count = skipped.length === 1 ? "1 entry" : `${skipped.length} entries`;
  return (
    `${count} skipped, the declared size passing the ${formatSize(ceiling)} ` +
    `${MAX_DOWNLOAD_SIZE_KEY} ceiling: ${listNames(skipped)}`
  );
}

/**
 * Whether an archive's content reads as UTF-8 text, which an archive entry
 * carries no charset to say. Only the first `maxBytes` are checked, the rest
 * never reaching the output; when that is a cut, a character the cut splits
 * is held back by the streaming decoder rather than read as a binary byte.
 */
function isUtf8Text(bytes: Uint8Array, maxBytes: number): boolean {
  const isCut = bytes.byteLength > maxBytes;
  try {
    new TextDecoder(UTF8, { fatal: true }).decode(isCut ? bytes.subarray(0, maxBytes) : bytes, {
      stream: isCut,
    });
    return true;
  } catch {
    return false;
  }
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
 * Charset labels read as UTF-8 rather than by their WHATWG meaning. US-ASCII is
 * the implicit charset of a `text/*` part that declares none (RFC 8621), and
 * WHATWG maps that label to windows-1252: honouring it would garble every
 * undeclared UTF-8 file, while UTF-8 reads true ASCII unchanged.
 */
const READ_AS_UTF8 = new Set(["us-ascii", "ascii"]);
const UTF8 = "utf-8";

/**
 * The encoding a text part's declared charset asks for. A label the runtime
 * does not know falls back to UTF-8, and the output says so.
 */
function encodingFor(charset: string | null): { encoding: string; note?: string } {
  const label = charset?.trim().toLowerCase() ?? "";
  if (label === "" || READ_AS_UTF8.has(label)) return { encoding: UTF8 };
  try {
    return { encoding: new TextDecoder(label).encoding };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return {
      encoding: UTF8,
      note: `declared charset ${charset} is not supported, decoded as UTF-8`,
    };
  }
}

/**
 * Cuts at a byte boundary, then decodes: cutting the decoded string instead
 * would count UTF-16 code units, not the bytes `maxBytes` promises. A cut that
 * lands inside a multi-byte character is not re-checked — `TextDecoder`
 * replaces the broken tail with a single U+FFFD, same as a truncated emoji
 * anywhere else in this server's output. The encoding is UTF-8 unless the
 * caller passes the one a declared charset asks for.
 */
function cutBytes(
  bytes: Uint8Array,
  maxBytes: number,
  encoding: string = UTF8,
): { text: string; isTruncated: boolean } {
  const decoder = new TextDecoder(encoding);
  if (bytes.byteLength <= maxBytes) {
    return { text: decoder.decode(bytes), isTruncated: false };
  }
  return { text: decoder.decode(bytes.subarray(0, maxBytes)), isTruncated: true };
}

/**
 * Base64 is ASCII, so a character count is a byte count and the cut needs no
 * decoder. Only the bytes the kept characters encode are encoded: every three
 * bytes become four characters, so `ceil(maxBytes / 4) * 3` bytes cover the cut
 * and the output matches the whole payload's base64 sliced at `maxBytes`.
 */
function cutBase64(bytes: Uint8Array, maxBytes: number): { text: string; isTruncated: boolean } {
  const isTruncated = Math.ceil(bytes.byteLength / 3) * 4 > maxBytes;
  const covered = bytes.subarray(0, Math.ceil(maxBytes / 4) * 3);
  const encoded = Buffer.from(covered.buffer, covered.byteOffset, covered.byteLength).toString(
    "base64",
  );
  return { text: encoded.slice(0, maxBytes), isTruncated };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
