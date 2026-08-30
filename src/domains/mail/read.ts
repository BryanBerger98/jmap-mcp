import { z } from "zod";
import type { GetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_MAIL } from "../../jmap/types/core.js";
import type {
  Email,
  EmailAddress,
  EmailBodyPart,
  EmailBodyValue,
  EmailGetArguments,
} from "../../jmap/types/mail.js";
import { defineTool } from "../../registry/define-tool.js";
import { htmlToText, renderFields } from "../../shared/render.js";
import { inRequestedOrder } from "./search.js";

/**
 * The ceiling on one body, in bytes.
 *
 * Five messages at this size land near ten thousand tokens, which is what a
 * single read is allowed to cost. `maxBodyBytes` lowers it, never raises it.
 */
export const MAX_BODY_VALUE_BYTES = 8000;

/** Reading is for messages already seen in a search; a bulk read is a search. */
const MAX_MESSAGES = 5;

/** Explicit: omitting `properties` pulls `bodyStructure` and every body value. */
const MESSAGE_PROPERTIES = [
  "id",
  "threadId",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "sentAt",
  "receivedAt",
  "hasAttachment",
  "size",
  "preview",
  "textBody",
  "htmlBody",
  "bodyValues",
] as const;

/** Only what the rendering reads: `partId` keys the body value, `type` picks it. */
const BODY_PROPERTIES = ["partId", "blobId", "type", "charset", "size", "name"] as const;

const SEPARATOR = `\n\n${"-".repeat(60)}\n\n`;

const inputSchema = z.object({
  ids: z
    .array(z.string())
    .min(1)
    .max(MAX_MESSAGES)
    .describe(`Message ids returned by mail_search, ${MAX_MESSAGES} at most per call.`),
  maxBodyBytes: z
    .number()
    .int()
    .min(200)
    .max(MAX_BODY_VALUE_BYTES)
    .optional()
    .describe(`Bytes of body to keep per message, ${MAX_BODY_VALUE_BYTES} by default.`),
});

export const mailRead = defineTool({
  name: "mail_read",
  title: "Read mail",
  description:
    `Reads up to ${MAX_MESSAGES} messages by id: headers, then the body as text. ` +
    `Each body is cut at ${MAX_BODY_VALUE_BYTES} bytes and the cut is announced in the output. ` +
    "A message with no plain-text part is degraded from its HTML, so the reply is never empty. " +
    "This tool takes ids, never a filter: run mail_search first and read the ids it returned.",
  inputSchema,
  classes: ["read"],
  classify: () => "read",
  summarize: (input) => `Read ${input.ids.length} message(s).`,
  run: async (input, { client, session }) => {
    const maxBodyValueBytes = Math.min(
      input.maxBodyBytes ?? MAX_BODY_VALUE_BYTES,
      MAX_BODY_VALUE_BYTES,
    );

    const args: EmailGetArguments = {
      accountId: session.accountId,
      ids: input.ids,
      properties: [...MESSAGE_PROPERTIES],
      bodyProperties: [...BODY_PROPERTIES],
      fetchTextBodyValues: true,
      fetchHTMLBodyValues: true,
      maxBodyValueBytes,
    };

    const response = await client.request<GetResponse<Email>>(
      [CAPABILITY_CORE, CAPABILITY_MAIL],
      ["Email/get", args, "0"],
    );

    // The caller's order carries intent; the server's answer order carries none.
    const blocks = inRequestedOrder(input.ids, response.list).map((email) =>
      renderMessage(email, maxBodyValueBytes),
    );

    if (response.notFound.length > 0) {
      blocks.push(`Not found: ${response.notFound.join(", ")}`);
    }

    return { text: blocks.length > 0 ? blocks.join(SEPARATOR) : "(no message found)" };
  },
});

function renderMessage(email: Email, maxBytes: number): string {
  const header = renderFields({
    id: email.id,
    date: email.receivedAt,
    from: formatAddresses(email.from),
    to: formatAddresses(email.to),
    cc: formatAddresses(email.cc),
    subject: email.subject,
    attachments: email.hasAttachment ? "yes" : "",
  });

  const body = bodyOf(email);
  const notes = [body.note, body.isTruncated ? truncationNote(maxBytes) : undefined].filter(
    (note): note is string => note !== undefined,
  );

  const footer = notes.length > 0 ? `\n\n[${notes.join(" — ")}]` : "";
  return `${header}\n\n${body.text}${footer}`;
}

/**
 * `maxBodyBytes` only lowers the ceiling, so inviting the caller to raise it is
 * only sound below the ceiling. At the ceiling the same advice buys a zod
 * rejection and a wasted round trip.
 */
function truncationNote(maxBytes: number): string {
  return maxBytes < MAX_BODY_VALUE_BYTES
    ? `body cut at ${maxBytes} bytes; ask for the rest by raising maxBodyBytes, up to ${MAX_BODY_VALUE_BYTES}`
    : `body cut at ${maxBytes} bytes; that ceiling is fixed, the rest of the body is out of this tool's reach`;
}

interface RenderedBody {
  text: string;
  isTruncated: boolean;
  /** Set when the text is not the message's own plain-text part. */
  note?: string;
}

/**
 * Falls back until something readable comes out: plain text, then HTML degraded
 * to text, then the server-made preview, then the headers alone. A read that
 * renders an empty body is worse than one that says why it is thin.
 */
function bodyOf(email: Email): RenderedBody {
  const text = firstBodyValue(email.textBody, email.bodyValues);
  if (text !== undefined && text.value.trim() !== "") {
    return { text: text.value.trim(), isTruncated: text.isTruncated };
  }

  const html = firstBodyValue(email.htmlBody, email.bodyValues);
  if (html !== undefined) {
    const degraded = htmlToText(html.value);
    if (degraded !== "") {
      return { text: degraded, isTruncated: html.isTruncated, note: "rendered from HTML" };
    }
  }

  if (email.preview !== undefined && email.preview.trim() !== "") {
    return {
      text: email.preview.trim(),
      isTruncated: false,
      note: "no body part was returned; this is the server preview",
    };
  }

  return { text: "(no readable body)", isTruncated: false, note: "headers only" };
}

function firstBodyValue(
  parts: EmailBodyPart[] | undefined,
  values: Record<string, EmailBodyValue> | undefined,
): EmailBodyValue | undefined {
  if (parts === undefined || values === undefined) return undefined;

  for (const part of parts) {
    if (part.partId === null) continue;
    const value = values[part.partId];
    if (value !== undefined) return value;
  }
  return undefined;
}

function formatAddresses(addresses: EmailAddress[] | null | undefined): string {
  if (addresses === null || addresses === undefined) return "";
  return addresses
    .map((address) =>
      address.name === null || address.name === ""
        ? address.email
        : `${address.name} <${address.email}>`,
    )
    .join(", ");
}
