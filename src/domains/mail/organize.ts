import type { GetResponse, Id, SetError, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_MAIL } from "../../jmap/types/core.js";
import type { Mailbox, MailboxGetArguments } from "../../jmap/types/mail.js";
import type { ToolContext } from "../../registry/define-tool.js";
import { renderTable } from "../../shared/render.js";

/*
 * What filing messages takes, shared by the tools that do it.
 *
 * `mail_move`, `mail_flag` and `mail_delete` refuse the same batches, read the
 * same folder list and account for the same partial outcomes. Those pieces live
 * here rather than in whichever tool happened to need them first.
 */

/**
 * How many message ids one call may carry.
 *
 * Not a configuration key, unlike the confirmation threshold: that one is a
 * personal caution and this one protects the server, which accepts 500 objects
 * per `/set` and would answer a batch of that size with one wall of text. It is
 * also the ceiling on how wrong a single mistaken call can go.
 */
export const MAX_IDS_PER_CALL = 50;

/** Only what a refusal, a confirmation and a rendered outcome name. */
export const ORGANIZE_MAILBOX_PROPERTIES = [
  "id",
  "name",
  "parentId",
  "role",
  "totalEmails",
] as const;

/** One read per handler invocation, whichever hook asks for it first. */
const MAILBOXES_KEY = "mail:mailboxes";

/**
 * The refusal an unusable batch raises, or `undefined` to go ahead.
 *
 * Raised from `precheck` rather than from the schema: a contract test calls the
 * handler directly, and a ceiling the schema alone enforced would never be
 * crossed by the very test written to prove it holds.
 */
export function refuseOversizedBatch(ids: readonly Id[]): string | undefined {
  if (ids.length === 0) {
    return (
      "Refused: no message id was given, so there is nothing to act on. " +
      "Run mail_search first and pass the ids it returns."
    );
  }

  if (ids.length > MAX_IDS_PER_CALL) {
    return (
      `Refused: ${ids.length} message ids were given, and this server acts on at most ` +
      `${MAX_IDS_PER_CALL} per call. Split the list into batches of ${MAX_IDS_PER_CALL} or fewer ` +
      "and call once per batch, so each batch is accounted for on its own."
    );
  }

  return undefined;
}

/**
 * Every folder of the account, read once per handler invocation.
 *
 * The whole list rather than the one folder a call names: naming the folder a
 * message came from, refusing a duplicate name, or walking a parent chain all
 * need the neighbours, and asking for them one by one would spend a round trip
 * each time.
 */
export function resolveMailboxes(context: ToolContext): Promise<Mailbox[]> {
  return context.once(MAILBOXES_KEY, async () => {
    const args: MailboxGetArguments = {
      accountId: context.session.accountId,
      ids: null,
      properties: [...ORGANIZE_MAILBOX_PROPERTIES],
    };

    const response = await context.client.request<GetResponse<Mailbox>>(
      [CAPABILITY_CORE, CAPABILITY_MAIL],
      ["Mailbox/get", args, "0"],
    );

    return response.list;
  });
}

/**
 * The folder the account puts deleted messages in, or `undefined`.
 *
 * Found by its role and never by its name: a French account calls it Corbeille,
 * and a folder someone named "Trash" by hand is not the one the mail client
 * empties. A missing role is a refusal upstream, never a folder created here —
 * `mail_delete` does not write in the tree.
 */
export async function resolveTrash(context: ToolContext): Promise<Mailbox | undefined> {
  const mailboxes = await resolveMailboxes(context);
  return mailboxes.find((mailbox) => mailbox.role === "trash");
}

/** The refusal a folder the account does not hold raises, in its own words. */
export function unknownMailbox(mailboxId: Id): string {
  return (
    `Refused: folder ${mailboxId} is not in this account, so nothing can be filed there. ` +
    "Run mail_folders to see the folders that exist and their ids."
  );
}

/**
 * Accounts for an `Email/set` update, id by id.
 *
 * `done` reads as a past participle — "moved to Archive", "marked $seen" — so
 * the same rendering serves every tool. An id absent from `notUpdated` counts
 * as done: the server names what it refused, and reading success off `updated`
 * instead would report a message as untouched on a server that answers with a
 * null patch.
 */
export function describeUpdateOutcome(
  response: SetResponse<unknown>,
  ids: readonly Id[],
  done: string,
): string {
  return describeOutcome(ids, response.notUpdated ?? {}, done);
}

/** The same account, for the `destroy` half of an `Email/set`. */
export function describeDestroyOutcome(
  response: SetResponse<unknown>,
  ids: readonly Id[],
  done = "destroyed",
): string {
  return describeOutcome(ids, response.notDestroyed ?? {}, done);
}

/**
 * The headline never claims a success the server did not grant: a batch the
 * server refused in part is reported as a part, and one it refused whole is
 * reported as nothing done at all.
 */
function describeOutcome(ids: readonly Id[], refused: Record<Id, SetError>, done: string): string {
  const rows = ids.map((id) => {
    const error = refused[id];
    return { id, outcome: error === undefined ? done : `refused: ${describeSetError(error)}` };
  });

  // Counted off the server's answer, never off the cell that was rendered from
  // it: a `done` wording that happened to read like a refusal would otherwise
  // move the headline.
  const failed = ids.filter((id) => refused[id] !== undefined).length;
  const succeeded = rows.length - failed;

  const headline =
    failed === 0
      ? `${succeeded} ${plural(succeeded)} ${done}.`
      : succeeded === 0
        ? `No message was ${done}: the mail server refused all ${rows.length}.`
        : `${succeeded} of ${rows.length} messages ${done}, ${failed} refused by the mail server.`;

  return `${headline}\n\n${renderTable(rows, ["id", "outcome"])}`;
}

/** The server's own words, which beat any guess at what it meant. */
function describeSetError(error: SetError): string {
  return error.description === undefined ? error.type : `${error.type} — ${error.description}`;
}

function plural(count: number): string {
  return count === 1 ? "message" : "messages";
}
