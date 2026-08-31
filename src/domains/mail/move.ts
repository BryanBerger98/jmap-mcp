import { z } from "zod";
import type { Id, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_MAIL } from "../../jmap/types/core.js";
import type { Email, EmailSetArguments, EmailSetUpdate, Mailbox } from "../../jmap/types/mail.js";
import { defineTool, type ToolContext } from "../../registry/define-tool.js";
import {
  describeUpdateOutcome,
  refuseOversizedBatch,
  resolveMailboxes,
  unknownMailbox,
} from "./organize.js";

const inputSchema = z.object({
  ids: z
    .array(z.string())
    .describe("The message ids to move, as returned by mail_search or mail_read."),
  mailboxId: z.string().describe("The id of the destination folder, as returned by mail_folders."),
});

export const mailMove = defineTool({
  name: "mail_move",
  title: "Move messages to a folder",
  description:
    "Moves the named messages into one folder. Each message leaves every folder it was in: " +
    "this files a message, it does not add a copy alongside the original. " +
    "It acts on message ids only — run mail_search first and pass the ids it returns, " +
    "because a search rerun here could match messages you never saw. " +
    "Moving is reversible: move the messages back to recover from a mistake.",
  inputSchema,
  // Reversible and never sends: what makes a large move worth a question is its
  // volume, and that is the escalation's business rather than the class's.
  classes: ["draft"],
  classify: () => "draft",
  summarize: async (input, context) =>
    `Move ${input.ids.length} ${input.ids.length === 1 ? "message" : "messages"} into ${await nameOf(input.mailboxId, context)}, out of every folder they are in now.`,
  precheck: async (input, context) => {
    const oversized = refuseOversizedBatch(input.ids);
    if (oversized !== undefined) return oversized;

    const target = await findMailbox(input.mailboxId, context);
    return target === undefined ? unknownMailbox(input.mailboxId) : undefined;
  },
  confirmWhen: async (input, context) =>
    input.ids.length > context.bulkConfirmAbove
      ? `This moves ${input.ids.length} messages into ${await nameOf(input.mailboxId, context)} at once, ` +
        `past the ${context.bulkConfirmAbove} this server files without asking.`
      : undefined,
  run: async (input, context) => {
    // Read before writing, and not only because `precheck` already looked: the
    // perimeter check in `mail_send` is redone in `run` for the same reason —
    // a hook that swallows a failed read must not have the last word.
    const target = await findMailbox(input.mailboxId, context);
    if (target === undefined) {
      return { text: unknownMailbox(input.mailboxId) };
    }

    // The whole property, not a `mailboxIds/<id>` path: patching one entry adds
    // the folder and leaves the message where it was, which is a copy, not a move.
    const patch: EmailSetUpdate = { mailboxIds: { [input.mailboxId]: true } };
    const args: EmailSetArguments = {
      accountId: context.session.accountId,
      update: Object.fromEntries(input.ids.map((id) => [id, patch])),
    };

    const response = await context.client.request<SetResponse<Email>>(
      [CAPABILITY_CORE, CAPABILITY_MAIL],
      ["Email/set", args, "0"],
    );

    return { text: describeUpdateOutcome(response, input.ids, `moved to ${target.name}`) };
  },
});

async function findMailbox(mailboxId: Id, context: ToolContext): Promise<Mailbox | undefined> {
  const mailboxes = await resolveMailboxes(context);
  return mailboxes.find((mailbox) => mailbox.id === mailboxId);
}

/**
 * The folder's name for a sentence a person reads, falling back on the id.
 *
 * A summary is written before the refusals run, so it has to survive a folder
 * that does not exist rather than assume `precheck` already caught it.
 */
async function nameOf(mailboxId: Id, context: ToolContext): Promise<string> {
  const target = await findMailbox(mailboxId, context);
  return target === undefined ? mailboxId : target.name;
}
