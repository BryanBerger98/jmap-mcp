import { z } from "zod";
import type { RecipientScope } from "../../config/recipients.js";
import type {
  AddressBook,
  AddressBookGetArguments,
  ContactCard,
  ContactCardFilterCondition,
  ContactCardQueryArguments,
} from "../../jmap/types/contacts.js";
import type { GetResponse, Id, QueryResponse, ResultReference } from "../../jmap/types/core.js";
import { CAPABILITY_CONTACTS, CAPABILITY_CORE } from "../../jmap/types/core.js";
import { defineTool } from "../../registry/define-tool.js";
import {
  DEFAULT_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  fingerprint,
  inRequestedOrder,
  takeWithinBudget,
} from "../../shared/pagination.js";
import { renderTable, truncate } from "../../shared/render.js";
import {
  BOOK_PROPERTIES,
  bookNames,
  displayName,
  primaryEmail,
  renderBooks,
  scopeMark,
} from "./card.js";

/** Explicit: omitting `properties` hands back the whole JSContact object. */
const ROW_PROPERTIES = ["id", "kind", "name", "emails", "organizations", "addressBookIds"] as const;

/**
 * How much rendered text one page may spend. Lower than the mail budget on
 * purpose: a card row is a name and an address, where a message row carries a
 * subject, so the same budget would hand back a page nobody asked for.
 */
const RESULT_BUDGET_CHARS = 3000;

/** `queryMaxResults` defaults to 5000 and is advertised nowhere: always send a limit. */
const MAX_LIMIT = 100;

/** The one order Stalwart sorts cards on that does not move under a paging run. */
const SORT: ContactCardQueryArguments["sort"] = [{ property: "created", isAscending: true }];

const SORT_NOTE =
  "Sorted by creation date, oldest first: the server refuses to sort cards by name.";

const NAME_INDEX_NOTE =
  "[`name` matched the one index the server keeps for the full name, the given name and the " +
  "surname alike, so it cannot narrow to a first name on its own.]";

const inputSchema = z.object({
  name: z.string().optional().describe("Substring matched against the name of the card."),
  email: z.string().optional().describe("Substring matched against the addresses of the card."),
  phone: z.string().optional().describe("Substring matched against the phone numbers."),
  organization: z.string().optional().describe("Substring matched against the organization."),
  note: z.string().optional().describe("Substring matched against the notes of the card."),
  text: z.string().optional().describe("Substring matched across every searchable field."),
  kind: z
    .enum(["individual", "group", "org", "location", "device", "application"])
    .optional()
    .describe("Restrict to one kind of card, e.g. group for a mailing group."),
  addressBookId: z
    .string()
    .optional()
    .describe("Restrict to one address book, as listed in the legend this search returns."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Cards to fetch, ${DEFAULT_PAGE_SIZE} by default.`),
  cursor: z
    .string()
    .optional()
    .describe("Cursor from a previous page. Resend the same criteria with it, or it is refused."),
});

export const contactsSearch = defineTool({
  name: "contacts_search",
  title: "Search contacts",
  description:
    "Searches contact cards and returns one line each: name, main address, organization, the " +
    "address books it sits in, and the id `contacts_read` takes. " +
    "Criteria are ANDed and all are optional — with none, the whole address book is walked page " +
    "by page, which is the ordinary way to consult it. " +
    "Cards come out oldest first: the server answers UnsupportedSort to a sort by name, so " +
    "creation date is the only stable order a paged run can rely on. " +
    "`name` hits a single index shared by the full name, the given name and the surname, so " +
    "filtering on a first name alone is not something this server can do. " +
    "A truncated page returns a cursor: pass it back along with the same criteria to continue.",
  inputSchema,
  classes: ["read"],
  classify: () => "read",
  summarize: () => "Search contact cards in the account.",
  run: async (input, { client, session, recipients }) => {
    const filter = buildFilter(input);
    const criteriaFingerprint = fingerprint(filter);
    const resumed = input.cursor === undefined ? undefined : decodeCursor(input.cursor);

    if (input.cursor !== undefined && resumed === undefined) {
      return { text: "Refused: that cursor is unreadable. Run the search again from the start." };
    }
    // A position only means something inside the result set that produced it.
    // Checked before the request, so criteria dropped along with the cursor
    // never turn into a walk of the whole book served under an old position.
    if (resumed !== undefined && resumed.criteriaFingerprint !== criteriaFingerprint) {
      return {
        text:
          "Refused: that cursor was issued for other criteria, so its position points into a " +
          "different result set. Resend the criteria of the first page with it, or search again " +
          "from the start.",
      };
    }

    const limit = input.limit ?? DEFAULT_PAGE_SIZE;
    const position = resumed?.position ?? 0;

    const queryArguments: ContactCardQueryArguments = {
      accountId: session.accountId,
      sort: SORT,
      position,
      limit,
      calculateTotal: true,
      ...(filter === undefined ? {} : { filter }),
    };

    const idsFromQuery: ResultReference = {
      resultOf: "0",
      name: "ContactCard/query",
      path: "/ids",
    };

    const bookArguments: AddressBookGetArguments = {
      accountId: session.accountId,
      ids: null,
      properties: [...BOOK_PROPERTIES],
    };

    // The three calls travel together: the back-reference feeds the second from
    // the first, and the books are independent, so a search costs one round trip
    // whatever the result count.
    const [query, fetched, books] = await client.requestMany<
      [QueryResponse, GetResponse<ContactCard>, GetResponse<AddressBook>]
    >(
      [CAPABILITY_CORE, CAPABILITY_CONTACTS],
      [
        ["ContactCard/query", queryArguments, "0"],
        [
          "ContactCard/get",
          {
            accountId: session.accountId,
            "#ids": idsFromQuery,
            properties: [...ROW_PROPERTIES],
          },
          "1",
        ],
        ["AddressBook/get", bookArguments, "2"],
      ],
    );

    if (resumed !== undefined && resumed.queryState !== query.queryState) {
      return {
        text:
          "Refused: the address books changed since that cursor was issued, so the next page " +
          "would skip or repeat cards. Run the search again from the start.",
      };
    }

    const byId = new Map<Id, AddressBook>(books.list.map((book) => [book.id, book]));
    const cards = inRequestedOrder(query.ids, fetched.list);
    const { taken, remaining } = takeWithinBudget(
      cards,
      (card) => Object.values(toRow(card, byId, recipients)).join("  "),
      RESULT_BUDGET_CHARS,
    );

    const count =
      query.total === undefined
        ? `${taken.length} card(s) shown.`
        : `${query.total} card(s) match, ${taken.length} shown from position ${position}.`;

    const columns = ["name", "email", "organization", "books", "id"];
    if (recipients.kind !== "anyone") columns.push("perimeter");

    const header = [
      `${count} ${SORT_NOTE}`,
      renderBooks(books.list),
      // Served only when it was earned: a sentence repeated on every call stops
      // being read by the time it matters.
      ...(input.name === undefined ? [] : [NAME_INDEX_NOTE]),
    ].join("\n");

    const table = renderTable(
      taken.map((card) => toRow(card, byId, recipients)),
      columns,
    );
    const text = `${header}\n\n${table}`;

    // A short page ends the run, and so does a full page that lands exactly on
    // the total: without that second test, the last page still hands back a
    // cursor and the client spends a round trip to be told the set is empty.
    const reachedTotal = query.total !== undefined && position + taken.length >= query.total;
    const exhausted = remaining === 0 && (query.ids.length < limit || reachedTotal);
    if (exhausted) return { text };

    return {
      text,
      nextCursor: encodeCursor({
        position: position + taken.length,
        queryState: query.queryState,
        criteriaFingerprint,
      }),
    };
  },
});

/**
 * Maps the input onto the RFC 9610 conditions, or to nothing at all.
 *
 * An absent filter is not a degraded call here: walking a whole address book is
 * what consulting one looks like, where walking a whole mailbox is not.
 */
function buildFilter(input: z.infer<typeof inputSchema>): ContactCardFilterCondition | undefined {
  const filter: ContactCardFilterCondition = {};

  if (input.name !== undefined) filter.name = input.name;
  if (input.email !== undefined) filter.email = input.email;
  if (input.phone !== undefined) filter.phone = input.phone;
  if (input.organization !== undefined) filter.organization = input.organization;
  if (input.note !== undefined) filter.note = input.note;
  if (input.text !== undefined) filter.text = input.text;
  if (input.kind !== undefined) filter.kind = input.kind;
  if (input.addressBookId !== undefined) filter.inAddressBook = input.addressBookId;

  return Object.keys(filter).length > 0 ? filter : undefined;
}

function toRow(
  card: ContactCard,
  byId: Map<Id, AddressBook>,
  scope: RecipientScope,
): Record<string, unknown> {
  const email = primaryEmail(card);

  return {
    name: truncate(displayName(card), 32),
    email: email ?? "",
    organization: truncate(firstOrganization(card), 24),
    books: bookNames(card, byId).join(", "),
    id: card.id,
    // The row shows one address, so it is that address the mark judges.
    perimeter: email === undefined ? "" : (scopeMark(email, scope) ?? ""),
  };
}

function firstOrganization(card: ContactCard): string {
  for (const entry of Object.values(card.organizations ?? {})) {
    const name = entry.name?.trim();
    if (name !== undefined && name !== "") return name;
  }
  return "";
}
