import { z } from "zod";
import type { Id, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_MAIL } from "../../jmap/types/core.js";
import type { Email, EmailSetArguments, EmailSetUpdate, Mailbox } from "../../jmap/types/mail.js";
import { STANDARD_KEYWORDS, type StandardKeyword } from "../../jmap/types/mail.js";
import { defineTool, type ToolContext } from "../../registry/define-tool.js";
import {
  describeUpdateOutcome,
  refuseOversizedBatch,
  resolveMailboxes,
  unknownMailbox,
} from "./filing.js";

/**
 * Filing a batch of messages, and marking one.
 *
 * Two verbs close enough to share a tool: the same class, the same batch of
 * ids, nothing either of them does that cannot be done back. What separates
 * them is not what they write but what they owe the user before writing it,
 * and that distinction is the whole reason this file is worth reading.
 *
 * A move at scale is a state nobody can reconstruct: the messages came from
 * folders the call never recorded, and moving them back means knowing where
 * back was. A marking at scale is undone by the opposite marking, on the same
 * ids, in one more call. So the volume escalates a move and never a flag, and
 * `confirmWhen` says so by branching on the action.
 */

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
    action: z
      .enum(["move", "flag"])
      .describe(
        "What to do: `move` files the messages into one folder, `flag` sets or clears keywords " +
          "on them without moving anything.",
      ),
    ids: z
      .array(z.string())
      .describe("The message ids to act on, as returned by mail_search or mail_read."),
    mailboxId: z
      .string()
      .optional()
      .describe(
        "On move, the id of the destination folder, as returned by mail_folders. Required on move.",
      ),
    add: z
      .array(keyword)
      .optional()
      .describe('On flag, keywords to set, written without their leading `$`. Example: ["seen"].'),
    remove: z
      .array(keyword)
      .optional()
      .describe("On flag, keywords to clear, written without their leading `$`."),
  })
  .refine((input) => input.action !== "move" || input.mailboxId !== undefined, {
    message: "Name the destination folder with `mailboxId`.",
    path: ["mailboxId"],
  })
  .refine(
    (input) =>
      input.action !== "flag" || (input.add?.length ?? 0) + (input.remove?.length ?? 0) > 0,
    {
      message:
        "Name at least one keyword to add or to remove, otherwise there is nothing to change.",
      path: ["add"],
    },
  );

export const mailOrganize = defineTool({
  name: "mail_organize",
  title: "Move or mark messages",
  description:
    "Files the named messages into one folder, or sets and clears their keywords: read, flagged, " +
    "answered, forwarded, junk, not junk, phishing. " +
    "A move takes each message out of every folder it was in — it files a message, it does not " +
    "add a copy alongside the original. A marking moves nothing: the messages stay where they are. " +
    "It acts on message ids only — run mail_search first and pass the ids it returns, because a " +
    "search rerun here could match messages you never saw. " +
    "Both directions are reversible, but a large move asks first while a marking never does.",
  inputSchema,
  // Reversible and never sends, whichever action is asked for: what makes a
  // large move worth a question is its volume, and that is the escalation's
  // business rather than the class's.
  classes: ["draft"],
  classify: () => "draft",
  summarize: async (input, context) =>
    input.action === "move"
      ? `Move ${countOf(input.ids)} into ${await nameOf(input.mailboxId, context)}, out of every folder they are in now.`
      : `${sentenceOf(input.add ?? [], input.remove ?? [])} on ${countOf(input.ids)}.`,
  precheck: async (input, context) => {
    const oversized = refuseOversizedBatch(input.ids);
    if (oversized !== undefined) return oversized;

    if (input.action !== "move") return undefined;
    if (input.mailboxId === undefined) {
      return "Refused: name the destination folder with `mailboxId` to move messages.";
    }

    const target = await findMailbox(input.mailboxId, context);
    return target === undefined ? unknownMailbox(input.mailboxId) : undefined;
  },
  // The first escalation in this project to branch on an action rather than on
  // a volume alone, and the branch is the point of the merge. A marking at any
  // scale is undone by the opposite marking on the same ids; a move at scale
  // leaves no record of the folders it emptied, so putting it back means
  // knowing something the call never wrote down.
  confirmWhen: async (input, context) =>
    input.action === "move" && input.ids.length > context.bulkConfirmAbove
      ? `This moves ${input.ids.length} messages into ${await nameOf(input.mailboxId, context)} at once, ` +
        `past the ${context.bulkConfirmAbove} this server files without asking.`
      : undefined,
  run: async (input, context) =>
    input.action === "move" ? move(input, context) : flag(input, context),
});

interface OrganizeInput {
  ids: string[];
  mailboxId?: string | undefined;
  add?: StandardKeyword[] | undefined;
  remove?: StandardKeyword[] | undefined;
}

async function move(input: OrganizeInput, context: ToolContext): Promise<{ text: string }> {
  if (input.mailboxId === undefined) {
    return { text: "Refused: name the destination folder with `mailboxId` to move messages." };
  }

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

  const response = await write(patch, input.ids, context);
  return { text: describeUpdateOutcome(response, input.ids, `moved to ${target.name}`) };
}

async function flag(input: OrganizeInput, context: ToolContext): Promise<{ text: string }> {
  const add = input.add ?? [];
  const remove = input.remove ?? [];

  // Removals first: a keyword named in both lists ends up set, which is the
  // reading that matches "mark these as read" over any competing intent.
  const patch: EmailSetUpdate = {
    ...Object.fromEntries(remove.map((word) => [`keywords/$${word}`, null])),
    ...Object.fromEntries(add.map((word) => [`keywords/$${word}`, true])),
  };

  const response = await write(patch, input.ids, context);
  return { text: describeUpdateOutcome(response, input.ids, sentenceOf(add, remove)) };
}

/** The same patch on every id: one `Email/set`, whichever action built it. */
function write(
  patch: EmailSetUpdate,
  ids: readonly Id[],
  context: ToolContext,
): Promise<SetResponse<Email>> {
  const args: EmailSetArguments = {
    accountId: context.session.accountId,
    update: Object.fromEntries(ids.map((id) => [id, patch])),
  };

  return context.client.request<SetResponse<Email>>(
    [CAPABILITY_CORE, CAPABILITY_MAIL],
    ["Email/set", args, "0"],
  );
}

function countOf(ids: readonly Id[]): string {
  return `${ids.length} ${ids.length === 1 ? "message" : "messages"}`;
}

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
async function nameOf(mailboxId: Id | undefined, context: ToolContext): Promise<string> {
  if (mailboxId === undefined) return "no folder";

  const target = await findMailbox(mailboxId, context);
  return target === undefined ? mailboxId : target.name;
}

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
