import { z } from "zod";
import type { GetResponse, Id, QueryResponse, ResultReference } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_MAIL } from "../../jmap/types/core.js";
import type {
  Email,
  EmailAddress,
  EmailFilterCondition,
  EmailQueryArguments,
} from "../../jmap/types/mail.js";
import { defineTool } from "../../registry/define-tool.js";
import {
  DEFAULT_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  takeWithinBudget,
} from "../../shared/pagination.js";
import { renderTable, truncate } from "../../shared/render.js";

/** Envelope only: omitting `properties` makes Stalwart pull the slow body properties. */
const ENVELOPE_PROPERTIES = [
  "id",
  "threadId",
  "from",
  "to",
  "subject",
  "receivedAt",
  "hasAttachment",
  "size",
] as const;

/**
 * How much rendered text one page may spend. The client's context is the scarce
 * resource, so the page is cut on size and the rest is handed back as a cursor.
 */
const RESULT_BUDGET_CHARS = 4000;

/** `queryMaxResults` defaults to 5000 and is advertised nowhere: always send a limit. */
const MAX_LIMIT = 100;

const inputSchema = z.object({
  from: z.string().optional().describe("Substring matched against the From header."),
  to: z.string().optional().describe("Substring matched against the To header."),
  deliveredTo: z
    .string()
    .optional()
    .describe("Alias the message was delivered to, matched on the Delivered-To header."),
  subject: z.string().optional().describe("Substring matched against the subject."),
  text: z.string().optional().describe("Substring matched against headers and body."),
  mailboxId: z.string().optional().describe("Restrict to one folder, as listed by mail_folders."),
  after: z
    .string()
    .optional()
    .describe("Received at or after this UTC date, e.g. 2026-08-01T00:00:00Z."),
  before: z.string().optional().describe("Received strictly before this UTC date."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe("Messages to fetch, 25 by default."),
  cursor: z
    .string()
    .optional()
    .describe("Cursor from a previous page. Resend the same criteria with it."),
});

export const mailSearch = defineTool({
  name: "mail_search",
  title: "Search mail",
  description:
    "Searches messages and returns their envelope: date, sender, subject, and the id `mail_read` takes. " +
    "Criteria are ANDed; at least one is required. Results are newest first. " +
    "A truncated page returns a cursor: pass it back along with the same criteria to continue. " +
    "The server has no notion of a newsletter, a bill or a mailing list — express such a question as criteria. " +
    "`deliveredTo` becomes a Delivered-To header condition; Stalwart drops a malformed header condition " +
    "without an error, so a result set can come back wider than asked.",
  inputSchema,
  classes: ["read"],
  classify: () => "read",
  summarize: () => "Search messages in the account.",
  run: async (input, { client, session }) => {
    const filter = buildFilter(input);
    const resumed = input.cursor === undefined ? undefined : decodeCursor(input.cursor);

    if (filter === undefined && input.cursor === undefined) {
      return { text: "Refused: give at least one criterion, or a cursor from a previous page." };
    }
    if (input.cursor !== undefined && resumed === undefined) {
      return { text: "Refused: that cursor is unreadable. Run the search again from the start." };
    }

    const limit = input.limit ?? DEFAULT_PAGE_SIZE;
    const position = resumed?.position ?? 0;

    const queryArguments: EmailQueryArguments = {
      accountId: session.accountId,
      // Stalwart accepts receivedAt; threadId is rejected as UnsupportedSort.
      sort: [{ property: "receivedAt", isAscending: false }],
      position,
      limit,
      calculateTotal: true,
      ...(filter === undefined ? {} : { filter }),
    };

    const idsFromQuery: ResultReference = { resultOf: "0", name: "Email/query", path: "/ids" };

    // Both calls travel together: the back-reference feeds the second from the
    // first, so a search costs one round trip whatever the result count.
    const [query, fetched] = await client.requestMany<[QueryResponse, GetResponse<Email>]>(
      [CAPABILITY_CORE, CAPABILITY_MAIL],
      [
        ["Email/query", queryArguments, "0"],
        [
          "Email/get",
          {
            accountId: session.accountId,
            "#ids": idsFromQuery,
            properties: [...ENVELOPE_PROPERTIES],
          },
          "1",
        ],
      ],
    );

    if (resumed !== undefined && resumed.queryState !== query.queryState) {
      return {
        text:
          "Refused: the mailbox changed since that cursor was issued, so the next page would " +
          "skip or repeat messages. Run the search again from the start.",
      };
    }

    const emails = inQueryOrder(query.ids, fetched.list);
    const { taken, remaining } = takeWithinBudget(emails, renderRow, RESULT_BUDGET_CHARS);

    const header =
      query.total === undefined
        ? `${taken.length} message(s) shown.`
        : `${query.total} message(s) match, ${taken.length} shown from position ${position}.`;

    const table = renderTable(taken.map(toRow), ["received", "from", "subject", "id"]);
    const text = `${header}\n\n${table}`;

    // A short page ends the run, and so does a full page that lands exactly on
    // the total: without that second test, the last page still hands back a
    // cursor and the client spends a round trip to be told the set is empty.
    // `total` is optional in the response, so it can only ever stop earlier.
    const reachedTotal = query.total !== undefined && position + taken.length >= query.total;
    const exhausted = remaining === 0 && (query.ids.length < limit || reachedTotal);
    if (exhausted) return { text };

    return {
      text,
      nextCursor: encodeCursor({ position: position + taken.length, queryState: query.queryState }),
    };
  },
});

function buildFilter(input: z.infer<typeof inputSchema>): EmailFilterCondition | undefined {
  const filter: EmailFilterCondition = {};

  if (input.from !== undefined) filter.from = input.from;
  if (input.to !== undefined) filter.to = input.to;
  if (input.subject !== undefined) filter.subject = input.subject;
  if (input.text !== undefined) filter.text = input.text;
  if (input.mailboxId !== undefined) filter.inMailbox = input.mailboxId;
  if (input.after !== undefined) filter.after = input.after;
  if (input.before !== undefined) filter.before = input.before;

  // Never folded into `to`: an alias is rewritten out of the To header, and the
  // header condition is the only place the original delivery address survives.
  if (input.deliveredTo !== undefined) filter.header = ["Delivered-To", input.deliveredTo];

  return Object.keys(filter).length > 0 ? filter : undefined;
}

/** `Email/get` does not promise the order of `ids`; the query does. */
function inQueryOrder(ids: Id[], list: Email[]): Email[] {
  const byId = new Map(list.map((email) => [email.id, email]));
  return ids.map((id) => byId.get(id)).filter((email): email is Email => email !== undefined);
}

function toRow(email: Email): Record<string, unknown> {
  return {
    received: email.receivedAt.slice(0, 16).replace("T", " "),
    from: truncate(formatAddress(email.from), 32),
    subject: truncate(email.subject ?? "(no subject)", 64),
    id: email.id,
  };
}

function renderRow(email: Email): string {
  return Object.values(toRow(email)).join("  ");
}

function formatAddress(addresses: EmailAddress[] | null): string {
  const [first] = addresses ?? [];
  if (first === undefined) return "(unknown)";
  return first.name === null || first.name === "" ? first.email : first.name;
}
