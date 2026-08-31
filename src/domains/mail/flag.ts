import { z } from "zod";
import type { SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_MAIL } from "../../jmap/types/core.js";
import type { Email, EmailSetArguments, EmailSetUpdate } from "../../jmap/types/mail.js";
import { STANDARD_KEYWORDS, type StandardKeyword } from "../../jmap/types/mail.js";
import { defineTool } from "../../registry/define-tool.js";
import { describeUpdateOutcome, refuseOversizedBatch } from "./organize.js";

/**
 * Only the keywords RFC 8621 gives a meaning to.
 *
 * A free-form string would let a typo invent a keyword the mail client never
 * shows, so the mistake would be invisible rather than reported. `$draft` is
 * absent on purpose: it is what tells the server a message is sendable, and
 * neither setting it nor clearing it is a marking.
 */
const keyword = z.enum(STANDARD_KEYWORDS);

const inputSchema = z
  .object({
    ids: z
      .array(z.string())
      .describe("The message ids to mark, as returned by mail_search or mail_read."),
    add: z
      .array(keyword)
      .optional()
      .describe('Keywords to set, written without their leading `$`. Example: ["seen"].'),
    remove: z
      .array(keyword)
      .optional()
      .describe("Keywords to clear, written without their leading `$`."),
  })
  .refine((input) => (input.add?.length ?? 0) + (input.remove?.length ?? 0) > 0, {
    message: "Name at least one keyword to add or to remove, otherwise there is nothing to change.",
    path: ["add"],
  });

export const mailFlag = defineTool({
  name: "mail_flag",
  title: "Mark or unmark messages",
  description:
    "Sets or clears keywords on the named messages: read, flagged, answered, forwarded, junk, " +
    "not junk, phishing. It touches no other keyword and moves nothing: a message stays in the " +
    "folders it is in. It acts on message ids only — run mail_search first and pass the ids it " +
    "returns. Marking loses nothing and is undone by marking the other way, so it runs without " +
    "asking however many messages it covers.",
  inputSchema,
  classes: ["draft"],
  classify: () => "draft",
  summarize: (input) =>
    `${sentenceOf(input.add ?? [], input.remove ?? [])} on ${input.ids.length} ${input.ids.length === 1 ? "message" : "messages"}.`,
  // The batch ceiling and nothing else: no `confirmWhen` here, because volume is
  // only worth a question when the thing being done at scale cannot be undone.
  precheck: (input) => refuseOversizedBatch(input.ids),
  run: async (input, context) => {
    const add = input.add ?? [];
    const remove = input.remove ?? [];

    // Removals first: a keyword named in both lists ends up set, which is the
    // reading that matches "mark these as read" over any competing intent.
    const patch: EmailSetUpdate = {
      ...Object.fromEntries(remove.map((word) => [`keywords/$${word}`, null])),
      ...Object.fromEntries(add.map((word) => [`keywords/$${word}`, true])),
    };

    const args: EmailSetArguments = {
      accountId: context.session.accountId,
      update: Object.fromEntries(input.ids.map((id) => [id, patch])),
    };

    const response = await context.client.request<SetResponse<Email>>(
      [CAPABILITY_CORE, CAPABILITY_MAIL],
      ["Email/set", args, "0"],
    );

    return { text: describeUpdateOutcome(response, input.ids, sentenceOf(add, remove)) };
  },
});

/** "marked $seen and $flagged, cleared $junk" — the same words in both places. */
function sentenceOf(add: readonly StandardKeyword[], remove: readonly StandardKeyword[]): string {
  const parts: string[] = [];
  if (add.length > 0) parts.push(`marked ${dollarize(add)}`);
  if (remove.length > 0) parts.push(`cleared ${dollarize(remove)}`);
  return parts.join(", ");
}

function dollarize(keywords: readonly StandardKeyword[]): string {
  return keywords.map((word) => `$${word}`).join(" and ");
}
