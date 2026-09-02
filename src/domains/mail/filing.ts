import type { GetResponse, Id, SetError, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_MAIL } from "../../jmap/types/core.js";
import type { Mailbox, MailboxGetArguments } from "../../jmap/types/mail.js";
import type { ToolContext } from "../../registry/define-tool.js";
import {
  type BatchSubject,
  MAX_IDS_PER_CALL,
  refuseOversizedBatch as refuseBatch,
} from "../../shared/batch.js";
import { describeSetError, renderTable } from "../../shared/render.js";

/*
 * What filing messages takes, shared by the tools that do it.
 *
 * `mail_organize` and `mail_delete` refuse the same batches, read the
 * same folder list and account for the same partial outcomes. Those pieces live
 * here rather than in whichever tool happened to need them first.
 */

/**
 * The shared ceiling, re-exported under the name the mail tools already call it.
 *
 * It lives in `shared/` now that contacts write too, and is named here so no
 * mail module has to know that a second domain exists.
 */
export { MAX_IDS_PER_CALL };

/** What a mail batch is made of, for the refusals below. */
const MESSAGES: BatchSubject = { noun: "message", discoveredBy: "mail_search" };

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
 * The refusal an unusable batch of messages raises, or `undefined` to go ahead.
 *
 * A thin naming of the shared check, so the three filing tools keep calling it
 * without repeating what a mail batch is made of at each call site.
 */
export function refuseOversizedBatch(ids: readonly Id[]): string | undefined {
  return refuseBatch(ids, MESSAGES);
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

/**
 * The refusal a folder the account does not hold raises, in its own words.
 *
 * `consequence` carries what the caller loses, because the same missing folder
 * means a different thing each time it is named: a destination nothing can be
 * filed into, a parent no folder can sit under, a folder there is nothing to
 * rename. The default states the filing case, which is the common one.
 */
export function unknownMailbox(mailboxId: Id, consequence = "nothing can be filed there"): string {
  return (
    `Refused: folder ${mailboxId} is not in this account, so ${consequence}. ` +
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

function plural(count: number): string {
  return count === 1 ? "message" : "messages";
}
