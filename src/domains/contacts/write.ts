import { z } from "zod";
import type {
  AddressBook,
  AddressBookGetArguments,
  ContactCard,
  ContactCardGetArguments,
  ContactCardQueryArguments,
  ContactCardSetArguments,
} from "../../jmap/types/contacts.js";
import type {
  GetResponse,
  Id,
  Invocation,
  QueryResponse,
  SetResponse,
} from "../../jmap/types/core.js";
import { CAPABILITY_CONTACTS, CAPABILITY_CORE } from "../../jmap/types/core.js";
import { defineTool, type ToolContext } from "../../registry/define-tool.js";
import { refuseOversizedBatch } from "../../shared/batch.js";
import { BOOK_PROPERTIES, KIND_GROUP } from "./card.js";
import {
  BOOKS_KEY,
  buildCreation,
  buildPatch,
  type CardEdit,
  defaultBook,
  describeCardOutcome,
  EDITABLE_PROPERTIES,
  outsidePerimeterNote,
  resolveBooks,
  resolveUids,
  resultingBooks,
} from "./edit.js";

/** The creation id the server maps to a real one; only ever one per call. */
const CREATION_KEY = "new";

/** What a batch of cards is made of, for the shared refusal. */
const CARDS = { noun: "contact card", discoveredBy: "contacts_search" };

/**
 * The fields that describe one person and cannot be spread over a batch.
 *
 * Filing several cards into an address book is a batch gesture; writing the same
 * phone number onto thirty people is not, and the refusal names which field was
 * asked for rather than saying the call was malformed.
 */
const SINGLE_CARD_FIELDS = [
  "name",
  "organization",
  "title",
  "nickname",
  "note",
  "kind",
  "emails",
  "phones",
  "members",
] as const;

const inputSchema = z.object({
  cardIds: z
    .array(z.string())
    .optional()
    .describe(
      "The ids of the cards to correct, as returned by contacts_search or contacts_read. " +
        "Leave it out to create a new card instead.",
    ),
  name: z.string().optional().describe("The full name of the person or group."),
  organization: z.string().optional().describe("The organization the person belongs to."),
  title: z.string().optional().describe("The person's job title."),
  nickname: z.string().optional().describe("A nickname for the person."),
  note: z.string().optional().describe("A free-form note kept on the card."),
  kind: z
    .enum(["individual", "group", "org", "location", "device", "application"])
    .optional()
    .describe("What the card describes. Only a card of kind group can hold members."),
  emails: z
    .object({
      add: z.array(z.string()).optional().describe("Email addresses to add to the card."),
      remove: z
        .array(z.string())
        .optional()
        .describe(
          "Email addresses to remove, given as the address itself, never as an internal key.",
        ),
    })
    .optional()
    .describe(
      "Email addresses to add or remove. Adding never overwrites an address already there.",
    ),
  phones: z
    .object({
      add: z.array(z.string()).optional().describe("Phone numbers to add to the card."),
      remove: z
        .array(z.string())
        .optional()
        .describe("Phone numbers to remove, given as the number itself, never as an internal key."),
    })
    .optional()
    .describe("Phone numbers to add or remove. Adding never overwrites a number already there."),
  addressBooks: z
    .object({
      set: z
        .array(z.string())
        .optional()
        .describe("Replaces the whole membership with these address book ids."),
      add: z.array(z.string()).optional().describe("Address book ids to file the cards into."),
      remove: z.array(z.string()).optional().describe("Address book ids to take the cards out of."),
    })
    .optional()
    .describe(
      "Which address books the cards sit in, by id as contacts_search lists them. " +
        "set cannot be combined with add or remove.",
    ),
  members: z
    .object({
      add: z.array(z.string()).optional().describe("Card ids to add to the group."),
      remove: z.array(z.string()).optional().describe("Card ids to remove from the group."),
    })
    .optional()
    .describe(
      "The members of a group card, given as card ids. The group stores uids and this tool " +
        "resolves them, so pass the ids contacts_search returns.",
    ),
});

type WriteInput = z.infer<typeof inputSchema>;

export const contactsWrite = defineTool({
  name: "contacts_write",
  title: "Create or correct a contact card",
  description:
    "Creates a contact card, or corrects the cards whose ids are given. " +
    "Only the fields you name are written: everything else on the card is left exactly as it was. " +
    "Adding an email address or a phone number never overwrites one already on the card — " +
    "remove takes the address or the number itself, so you never have to know an internal key. " +
    "It takes no search criteria: run contacts_search first and pass the ids it returns, " +
    "because a search rerun here could match cards you never saw.",
  inputSchema,
  // Nothing here destroys or sends: a correction is reversible by another one,
  // and what makes a large batch worth a question is its volume, which is the
  // escalation's business rather than the class's.
  classes: ["draft"],
  classify: () => "draft",
  summarize: async (input, context) => {
    const ids = input.cardIds ?? [];
    if (ids.length === 0) return `Create a contact card for ${input.name ?? "a new contact"}.`;

    return `Correct ${await nameCards(ids, context)}.`;
  },
  precheck: (input, context) => refuse(input, context),
  confirmWhen: (input, context) => {
    const count = (input.cardIds ?? []).length;
    return Promise.resolve(
      count > context.bulkConfirmAbove
        ? `This writes to ${count} contact cards at once, past the ${context.bulkConfirmAbove} ` +
            "this server writes without asking."
        : undefined,
    );
  },
  run: async (input, context) => {
    // Read before writing, and not only because `precheck` already looked: a
    // hook that swallowed a failed read must not have the last word, exactly as
    // in `mail_move` and in the recipient perimeter.
    const refusal = await refuse(input, context);
    if (refusal !== undefined) return { text: refusal };

    return (input.cardIds ?? []).length === 0
      ? createCard(input, context)
      : correctCards(input, context);
  },
});

/**
 * Everything that makes the call vain, before anything is written.
 *
 * Shared by `precheck` and `run` rather than written twice: the reads it needs
 * go through `context.once`, so asking twice costs one round trip.
 */
async function refuse(input: WriteInput, context: ToolContext): Promise<string | undefined> {
  const ids = input.cardIds ?? [];

  if (ids.length > 0) {
    const oversized = refuseOversizedBatch(ids, CARDS);
    if (oversized !== undefined) return oversized;
  }

  if (ids.length > 1) {
    const spread = SINGLE_CARD_FIELDS.filter((field) => input[field] !== undefined);
    if (spread.length > 0) {
      return (
        `Refused: ${spread.join(", ")} ${spread.length === 1 ? "describes" : "describe"} one ` +
        `person, and ${ids.length} card ids were given. Writing the same value onto every card ` +
        "in a batch is almost never the intent — call once per card, or drop the field and keep " +
        "only addressBooks, which does file a batch."
      );
    }
  }

  // Stated as a sentence here rather than left to `buildPatch`, which throws on
  // it, and to `createCard`, which silently keeps `set` and drops `add`: the
  // constraint is the schema's prose, so a call breaking it deserves the reason.
  const membership = input.addressBooks;
  if (
    membership?.set !== undefined &&
    ((membership.add ?? []).length > 0 || (membership.remove ?? []).length > 0)
  ) {
    return (
      "Refused: addressBooks.set replaces the whole membership while add and remove amend it, " +
      "and RFC 8620 §5.3 forbids one patch being the prefix of another. Pass set alone, with " +
      "the full list of books the cards are to sit in, or pass add and remove alone."
    );
  }

  if (ids.length === 0) {
    const named = input.name?.trim();
    const addressed = input.emails?.add ?? [];
    if ((named === undefined || named === "") && addressed.length === 0) {
      return (
        "Refused: a new card needs at least a name or an email address. Without one, nothing " +
        "would designate the card afterwards and every listing would show it as (unnamed)."
      );
    }

    // A creation has no membership to amend, and the creation path reads `set`
    // and `add` alone: accepting a `remove` here would drop it without a word.
    if ((input.addressBooks?.remove ?? []).length > 0) {
      return (
        "Refused: a new card cannot be taken out of an address book it was never in. Name the " +
        "books it is to land in with addressBooks.add, and drop addressBooks.remove."
      );
    }
  }

  // From here on the address books are needed, so they are read — but only when
  // the call names one, or creates a card that has to land somewhere.
  const namesBooks = input.addressBooks !== undefined;
  await prefetch(ids, namesBooks, context);

  if (namesBooks || ids.length === 0) {
    const books = await resolveBooks(context);
    const known = new Set(books.map((book) => book.id));

    // What a creation would land in, which is what `createCard` reads: a book
    // named only to be removed from files nothing, so it cannot answer for the
    // absence of a default one.
    const filed = [...(input.addressBooks?.set ?? []), ...(input.addressBooks?.add ?? [])];
    const asked = [...filed, ...(input.addressBooks?.remove ?? [])];

    const unknown = asked.find((id) => !known.has(id));
    if (unknown !== undefined) {
      return (
        `Refused: address book ${unknown} is not in this account, so no card can be filed ` +
        "there. Run contacts_search to see the address books that exist and their ids."
      );
    }

    if (ids.length === 0 && filed.length === 0 && defaultBook(books) === undefined) {
      return (
        "Refused: this account marks no default address book, so there is no book to put a new " +
        `card in. Name one in addressBooks.add — the account holds ${describeBooks(books)}.`
      );
    }
  }

  if (ids.length === 0) return undefined;

  // The last two refusals read the cards themselves: whether a correction would
  // leave one in no book at all, and whether a card can hold members, are both
  // answers only the card carries.
  const cards = await readCards(ids, context);

  if (input.addressBooks !== undefined) {
    const emptied = cards.find((card) => resultingBooks(card, toEdit(input, new Map())).size === 0);
    if (emptied !== undefined) {
      return (
        `Refused: this would leave card ${emptied.id} in no address book, and a card belongs to ` +
        "at least one for as long as it exists. File it somewhere else in the same call, or " +
        "delete it with contacts_delete if that is what you meant."
      );
    }
  }

  if (input.members !== undefined) {
    const notGroup = cards.find((card) => card.kind !== KIND_GROUP);
    if (notGroup !== undefined) {
      return (
        `Refused: card ${notGroup.id} is of kind ${notGroup.kind ?? "individual"}, and only a ` +
        "card of kind group holds members. Set kind to group on it first, in this same tool, " +
        "if it is meant to be one."
      );
    }
  }

  return undefined;
}

/**
 * The two reads a filing needs, in one round trip rather than two.
 *
 * `resolveBooks` and `readCards` each own a cache key, and asking them in turn
 * would spend a round trip each: filing three cards into a book would cost three
 * where it costs two. Both keys are seeded from a single request instead, and
 * the readers stay lazy so a second pass through `refuse` issues nothing.
 */
async function prefetch(
  ids: readonly Id[],
  needsBooks: boolean,
  context: ToolContext,
): Promise<void> {
  // With only one of the two to read, the helper that owns it is already the
  // single round trip: there is nothing to pair it with.
  if (!needsBooks || ids.length === 0) return;

  let combined: Promise<[GetResponse<AddressBook>, GetResponse<ContactCard>]> | undefined;
  const both = () =>
    (combined ??= context.client.requestMany<[GetResponse<AddressBook>, GetResponse<ContactCard>]>(
      [CAPABILITY_CORE, CAPABILITY_CONTACTS],
      [
        ["AddressBook/get", booksArguments(context), "b"],
        ["ContactCard/get", cardsArguments(ids, context), "c"],
      ],
    ));

  await Promise.all([
    context.once(BOOKS_KEY, async () => (await both())[0].list),
    context.once(cardsKey(ids), async () => (await both())[1].list),
  ]);
}

/** Creates the card, and says where it landed rather than that it is done. */
async function createCard(input: WriteInput, context: ToolContext) {
  const books = await resolveBooks(context);
  const asked = input.addressBooks?.set ?? input.addressBooks?.add ?? [];
  // `refuse` has already established that one of the two exists.
  const bookIds = asked.length > 0 ? asked : [(defaultBook(books) as { id: Id }).id];

  const written = writtenAddresses(input);
  const args: ContactCardSetArguments = {
    accountId: context.session.accountId,
    create: { [CREATION_KEY]: buildCreation(toEdit(input, new Map()), bookIds) },
  };

  const responses = await context.client.requestMany<unknown[]>(
    [CAPABILITY_CORE, CAPABILITY_CONTACTS],
    // The duplicate lookup travels with the write and therefore sees the state
    // before it: asking afterwards would find the card that was just created.
    [...duplicateLookups(written, context), ["ContactCard/set", args, "w"]],
  );

  const response = responses[responses.length - 1] as SetResponse<ContactCard>;
  const created = response.created?.[CREATION_KEY];
  const rejected = response.notCreated?.[CREATION_KEY];

  if (created === undefined) {
    const reason = rejected === undefined ? "the server said nothing" : describeReason(rejected);
    return { text: `No card was created: ${reason}.` };
  }

  const bookNames = bookIds.map((id) => books.find((book) => book.id === id)?.name ?? id);
  const lines = [
    `Created contact card ${created.id} in ${bookNames.join(", ")}.`,
    duplicateNote(written, responses.slice(0, -1) as QueryResponse[], []),
    outsidePerimeterNote(written, context.recipients),
  ];

  return { text: lines.filter((line): line is string => line !== undefined).join("\n\n") };
}

/** Corrects each named card, and accounts for every id the server refused. */
async function correctCards(input: WriteInput, context: ToolContext) {
  const ids = input.cardIds ?? [];
  const cards = await readCards(ids, context);
  const byId = new Map(cards.map((card) => [card.id, card]));

  const uids = await resolveMemberUids(input, context);
  const edit = toEdit(input, uids);

  const update: Record<Id, Record<string, unknown>> = {};
  for (const id of ids) {
    const card = byId.get(id);
    // A card the read did not return is left out of the patch rather than sent
    // a blind one. It is also left out of the accounting below: the server was
    // never asked about it, so its silence says nothing about that id.
    if (card !== undefined) update[id] = buildPatch(card, edit);
  }

  const patched = Object.keys(update);
  const missing = ids.filter((id) => update[id] === undefined);

  const written = writtenAddresses(input);
  const args: ContactCardSetArguments = { accountId: context.session.accountId, update };

  const responses = await context.client.requestMany<unknown[]>(
    [CAPABILITY_CORE, CAPABILITY_CONTACTS],
    [...duplicateLookups(written, context), ["ContactCard/set", args, "w"]],
  );

  const response = responses[responses.length - 1] as SetResponse<ContactCard>;
  const lines = [
    patched.length === 0 ? undefined : describeCardOutcome(response, patched, "updated"),
    missing.length === 0 ? undefined : `Not found: ${missing.join(", ")}`,
    duplicateNote(written, responses.slice(0, -1) as QueryResponse[], ids),
    outsidePerimeterNote(written, context.recipients),
  ];

  return { text: lines.filter((line): line is string => line !== undefined).join("\n\n") };
}

/**
 * One `ContactCard/query` per address written, to be sent alongside the write.
 *
 * A duplicate never blocks: two cards may legitimately share an address, and the
 * caller is the one who knows. Saying nothing at all is the option that costs
 * somebody a silent second copy of the same person.
 */
function duplicateLookups(addresses: readonly string[], context: ToolContext): Invocation[] {
  return addresses.map((address, index): Invocation => {
    const args: ContactCardQueryArguments = {
      accountId: context.session.accountId,
      filter: { email: address },
      limit: 5,
    };
    return ["ContactCard/query", args, `q${index}`];
  });
}

function duplicateNote(
  addresses: readonly string[],
  responses: readonly QueryResponse[],
  written: readonly Id[],
): string | undefined {
  const seen = new Set(written);

  const found = addresses.filter((_address, index) => {
    const matches = responses[index]?.ids ?? [];
    return matches.some((id) => !seen.has(id));
  });

  if (found.length === 0) return undefined;

  return (
    `Note: ${found.join(", ")} ${found.length === 1 ? "was" : "were"} already on another card ` +
    "in this account before this write. The write went through — run contacts_search on the " +
    "address to see both cards and merge them if that was not intended."
  );
}

/** Every email address this call puts on a card, for the two notes below. */
function writtenAddresses(input: WriteInput): string[] {
  return input.emails?.add ?? [];
}

/**
 * The uids of the member cards named, since `members` is keyed by uid.
 *
 * A card id nobody could resolve is dropped rather than written as-is: a group
 * holding a JMAP id where a uid belongs holds nobody, and silently.
 */
async function resolveMemberUids(
  input: WriteInput,
  context: ToolContext,
): Promise<Map<Id, string>> {
  const named = [...(input.members?.add ?? []), ...(input.members?.remove ?? [])];
  return named.length === 0 ? new Map() : resolveUids(context, named);
}

/** The tool's arguments as the patch builder takes them. */
function toEdit(input: WriteInput, uids: Map<Id, string>): CardEdit {
  const edit: CardEdit = {
    name: input.name,
    organization: input.organization,
    title: input.title,
    nickname: input.nickname,
    note: input.note,
    kind: input.kind,
    emails: input.emails,
    phones: input.phones,
    addressBooks: input.addressBooks,
  };

  if (input.members !== undefined) {
    edit.members = {
      add: (input.members.add ?? []).map((id) => uids.get(id)).filter(isPresent),
      remove: (input.members.remove ?? []).map((id) => uids.get(id)).filter(isPresent),
    };
  }

  return edit;
}

/**
 * The cards a correction is about to patch, read once per handler invocation.
 *
 * Only the properties the patch reasons about: a `get` with `properties: null`
 * would carry the whole card over the wire for the sake of one pointer.
 */
function readCards(ids: readonly Id[], context: ToolContext): Promise<ContactCard[]> {
  return context.once(cardsKey(ids), async () => {
    const response = await context.client.request<GetResponse<ContactCard>>(
      [CAPABILITY_CORE, CAPABILITY_CONTACTS],
      ["ContactCard/get", cardsArguments(ids, context), "0"],
    );

    return response.list;
  });
}

/** Keyed by the ids themselves, sorted, so the order they were given cannot miss. */
function cardsKey(ids: readonly Id[]): string {
  return `contacts:write:${[...ids].sort().join(",")}`;
}

function cardsArguments(ids: readonly Id[], context: ToolContext): ContactCardGetArguments {
  return {
    accountId: context.session.accountId,
    ids: [...ids],
    properties: [...EDITABLE_PROPERTIES],
  };
}

function booksArguments(context: ToolContext): AddressBookGetArguments {
  return {
    accountId: context.session.accountId,
    ids: null,
    properties: [...BOOK_PROPERTIES],
  };
}

/**
 * The cards named, for a sentence a person reads before confirming.
 *
 * A summary runs before the refusals, so it degrades to a count rather than
 * failing the call over a read it only needed for its wording.
 */
async function nameCards(ids: readonly Id[], context: ToolContext): Promise<string> {
  const counted = `${ids.length} contact ${ids.length === 1 ? "card" : "cards"}`;

  try {
    const cards = await readCards(ids, context);
    const named = cards.map((card) => card.name?.full).filter(isPresent);
    return named.length === 0 ? counted : `${counted} (${named.join(", ")})`;
  } catch {
    return counted;
  }
}

function describeBooks(books: readonly { id: Id; name: string }[]): string {
  return books.length === 0
    ? "no address book at all"
    : books.map((book) => `${book.name} (${book.id})`).join(", ");
}

function describeReason(error: { type: string; description?: string }): string {
  return error.description === undefined ? error.type : `${error.type} — ${error.description}`;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
