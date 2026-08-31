import { z } from "zod";
import type {
  AddressBook,
  AddressBookGetArguments,
  ContactCard,
  ContactCardGetArguments,
} from "../../jmap/types/contacts.js";
import type { GetResponse, Id } from "../../jmap/types/core.js";
import { CAPABILITY_CONTACTS, CAPABILITY_CORE } from "../../jmap/types/core.js";
import { defineTool } from "../../registry/define-tool.js";
import { BOOK_PROPERTIES, renderCard } from "./card.js";
import { inRequestedOrder } from "./search.js";

/**
 * How many cards one call may read.
 *
 * Higher than `mail_read` allows messages: a card is a handful of fields where
 * a message carries a body, so reading a small group of people at once is a
 * normal gesture rather than a bulk export.
 */
export const MAX_CARDS = 20;

/** Explicit: omitting `properties` hands back the whole JSContact object. */
const DETAIL_PROPERTIES = [
  "id",
  "kind",
  "uid",
  "name",
  "nicknames",
  "organizations",
  "titles",
  "emails",
  "phones",
  "onlineServices",
  "addresses",
  "notes",
  "members",
  "addressBookIds",
  "created",
  "updated",
] as const;

const SEPARATOR = `\n\n${"-".repeat(60)}\n\n`;

const inputSchema = z.object({
  ids: z
    .array(z.string())
    .min(1)
    .max(MAX_CARDS)
    .describe(`Card ids returned by contacts_search, ${MAX_CARDS} at most per call.`),
});

export const contactsRead = defineTool({
  name: "contacts_read",
  title: "Read contacts",
  description:
    `Reads up to ${MAX_CARDS} contact cards by id: name, addresses, phones, organization, ` +
    "titles, postal addresses, notes, and the address books the card sits in. " +
    "A card of kind `group` is rendered as it stands, its members listed by uid rather than read. " +
    "This tool takes ids, never a filter: run contacts_search first and read the ids it returned.",
  inputSchema,
  classes: ["read"],
  classify: () => "read",
  summarize: (input) => `Read ${input.ids.length} contact card(s).`,
  run: async (input, { client, session, recipients }) => {
    const cardArguments: ContactCardGetArguments = {
      accountId: session.accountId,
      ids: input.ids,
      properties: [...DETAIL_PROPERTIES],
    };

    const bookArguments: AddressBookGetArguments = {
      accountId: session.accountId,
      ids: null,
      properties: [...BOOK_PROPERTIES],
    };

    // Both calls travel together with no back-reference between them: they are
    // independent, and a card that cannot name its books is half a read.
    const [fetched, books] = await client.requestMany<
      [GetResponse<ContactCard>, GetResponse<AddressBook>]
    >(
      [CAPABILITY_CORE, CAPABILITY_CONTACTS],
      [
        ["ContactCard/get", cardArguments, "0"],
        ["AddressBook/get", bookArguments, "1"],
      ],
    );

    const byId = new Map<Id, AddressBook>(books.list.map((book) => [book.id, book]));

    // The caller's order carries intent; the server's answer order carries none.
    const blocks = inRequestedOrder(input.ids, fetched.list).map((card) =>
      renderCard(card, byId, recipients),
    );

    if (fetched.notFound.length > 0) {
      blocks.push(`Not found: ${fetched.notFound.join(", ")}`);
    }

    return { text: blocks.length > 0 ? blocks.join(SEPARATOR) : "(no card found)" };
  },
});
