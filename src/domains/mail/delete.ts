import { z } from "zod";
import type { GetResponse, Id, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_MAIL } from "../../jmap/types/core.js";
import type { Email, EmailGetArguments, EmailSetArguments } from "../../jmap/types/mail.js";
import { defineTool, type ToolContext } from "../../registry/define-tool.js";
import { truncate } from "../../shared/render.js";
import {
  describeDestroyOutcome,
  describeUpdateOutcome,
  refuseOversizedBatch,
  resolveTrash,
} from "./filing.js";

/** How many subjects a confirmation spells out before it counts the rest. */
const SUBJECTS_NAMED = 5;

const inputSchema = z.object({
  ids: z
    .array(z.string())
    .describe("The message ids to delete, as returned by mail_search or mail_read."),
  permanent: z
    .boolean()
    .optional()
    .describe(
      "Destroy the messages outright instead of moving them to the trash folder. " +
        "Nothing undoes this: no trash holds them, and no later call brings them back. " +
        "Defaults to false.",
    ),
});

export const mailDelete = defineTool({
  name: "mail_delete",
  title: "Delete messages",
  description:
    "Moves the named messages to the trash folder, where they stay readable and can be moved " +
    "back out with mail_organize. Set `permanent` to destroy them instead: that erases them from " +
    "the mail server for good, with no trash to recover them from and no way to undo it. " +
    "It acts on message ids only — run mail_search first and pass the ids it returns.",
  inputSchema,
  // Two classes on one tool, because one boolean is the whole difference: the
  // registry reads the class off the arguments, so `permanent` alone decides
  // whether this call is a reversible filing or an erasure.
  classes: ["draft", "destroy"],
  classify: (input) => (input.permanent === true ? "destroy" : "draft"),
  summarize: async (input, context) => {
    const what = await describeMessages(input.ids, context);
    return input.permanent === true
      ? `Permanently destroy ${what}. Nothing recovers them afterwards: they are erased from the mail server, not moved to the trash.`
      : `Move ${what} to the trash folder, where they stay readable.`;
  },
  precheck: async (input, context) => {
    const oversized = refuseOversizedBatch(input.ids);
    if (oversized !== undefined) return oversized;

    // Only the trash branch has a precondition. The destroying branch has one
    // guard and it is the confirmation, which is the registry's business.
    if (input.permanent === true) return undefined;

    const trash = await resolveTrash(context);
    return trash === undefined
      ? "Refused: this account has no folder with the `trash` role, so there is nowhere to put a " +
          "deleted message. This server does not create one. Either create a trash folder in your " +
          "mail client, move the messages to a folder of your choice with mail_organize, or call " +
          "mail_delete again with `permanent` to erase them for good."
      : undefined;
  },
  confirmWhen: async (input, context) => {
    // Never on the destroying branch: that one is already a `destroy`, asked by
    // its class, and a volume reason would replace "this cannot be undone" with
    // a sentence about counting.
    if (input.permanent === true || input.ids.length <= context.bulkConfirmAbove) return undefined;

    const trash = await resolveTrash(context);
    return (
      `This moves ${input.ids.length} messages to the trash folder${trash === undefined ? "" : ` (${trash.name})`} at once, ` +
      `past the ${context.bulkConfirmAbove} this server files without asking.`
    );
  },
  run: async (input, context) => {
    // The two branches never share a request, and the destroying one never
    // follows a move: a message that was filed and then destroyed would be
    // erased by a call the user confirmed as a filing.
    if (input.permanent === true) {
      const args: EmailSetArguments = {
        accountId: context.session.accountId,
        destroy: [...input.ids],
      };

      const response = await context.client.request<SetResponse<Email>>(
        [CAPABILITY_CORE, CAPABILITY_MAIL],
        ["Email/set", args, "0"],
      );

      return { text: describeDestroyOutcome(response, input.ids) };
    }

    const trash = await resolveTrash(context);
    if (trash === undefined) {
      return {
        text:
          "Refused: this account has no folder with the `trash` role, so nothing was deleted. " +
          "No folder was created either.",
      };
    }

    const args: EmailSetArguments = {
      accountId: context.session.accountId,
      update: Object.fromEntries(input.ids.map((id) => [id, { mailboxIds: { [trash.id]: true } }])),
    };

    const response = await context.client.request<SetResponse<Email>>(
      [CAPABILITY_CORE, CAPABILITY_MAIL],
      ["Email/set", args, "0"],
    );

    return { text: describeUpdateOutcome(response, input.ids, `moved to ${trash.name}`) };
  },
});

/**
 * "3 messages: "Facture", "Réunion" and 1 more" — what a person weighs.
 *
 * A count alone is not something anyone can arbitrate: confirming the erasure
 * of "3 messages" is confirming a number. A failed read degrades to that count
 * rather than to a refusal, because a transport hiccup must not turn into a
 * verdict on the call.
 */
async function describeMessages(ids: readonly Id[], context: ToolContext): Promise<string> {
  const count = `${ids.length} ${ids.length === 1 ? "message" : "messages"}`;
  const subjects = await readSubjects(ids, context);
  if (subjects.length === 0) return count;

  const named = subjects.slice(0, SUBJECTS_NAMED).map((subject) => `"${subject}"`);
  const rest = ids.length - named.length;
  return `${count}: ${named.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}

/** `id` and `subject` and nothing else: a body here would be paid for twice. */
async function readSubjects(ids: readonly Id[], context: ToolContext): Promise<string[]> {
  const args: EmailGetArguments = {
    accountId: context.session.accountId,
    ids: [...ids],
    properties: ["id", "subject"],
  };

  try {
    const response = await context.once(`mail:subjects:${ids.join(",")}`, () =>
      context.client.request<GetResponse<Email>>(
        [CAPABILITY_CORE, CAPABILITY_MAIL],
        ["Email/get", args, "0"],
      ),
    );

    return response.list.map((email) => truncate(email.subject ?? "(no subject)", 60));
  } catch {
    // The summary is a courtesy, not a check: a read that fails leaves the
    // confirmation naming a count, and the call itself still goes to the user.
    return [];
  }
}
