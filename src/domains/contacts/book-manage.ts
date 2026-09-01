import { z } from "zod";
import type {
  AddressBook,
  AddressBookSetArguments,
  ContactCardQueryArguments,
} from "../../jmap/types/contacts.js";
import type { Id, QueryResponse, SetError, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CONTACTS, CAPABILITY_CORE } from "../../jmap/types/core.js";
import { defineTool, type ToolContext } from "../../registry/define-tool.js";
import { resolveBooks } from "./edit.js";

/** The key a creation is filed under: JMAP hands back the real id in `created`. */
const CREATION_KEY = "new";

/** The actions that give a book a name, and so can clash with an existing one. */
const NAMING_ACTIONS = new Set(["create", "rename"]);

const inputSchema = z
  .object({
    action: z
      .enum(["create", "rename", "delete"])
      .describe(
        "What to do: create an address book, rename one, or delete one. Address books have no " +
          "hierarchy, so there is nothing to move one into.",
      ),
    bookId: z
      .string()
      .optional()
      .describe(
        "The address book to act on, as returned by contacts_search. Required except on create.",
      ),
    name: z.string().optional().describe("The book name. Required on create and rename."),
  })
  .refine((input) => input.action === "create" || input.bookId !== undefined, {
    message: "Name the address book to act on with `bookId`.",
    path: ["bookId"],
  })
  .refine((input) => !NAMING_ACTIONS.has(input.action) || input.name !== undefined, {
    message: "Give the address book a `name`.",
    path: ["name"],
  });

export const contactsBookManage = defineTool({
  name: "contacts_book_manage",
  title: "Create, rename or delete an address book",
  description:
    "Manages the address books of the account: creates one, renames one, or deletes one. " +
    "Deleting a book never deletes the cards it holds — a book still holding cards is refused " +
    "instead, so move them with contacts_write first. The default book and the last remaining " +
    "book cannot be deleted, because a card belongs to at least one book for as long as it " +
    "exists. Address books have no hierarchy: there is no parent and nothing to move.",
  inputSchema,
  // Only `delete` can lose anything, and only that action classifies as one.
  classes: ["draft", "destroy"],
  classify: (input) => (input.action === "delete" ? "destroy" : "draft"),
  summarize: async (input, context) => {
    const named =
      (await find(input.bookId, context))?.name ?? input.bookId ?? input.name ?? "a book";

    switch (input.action) {
      case "create":
        return `Create the address book ${givenName(input)}.`;
      case "rename":
        return `Rename the address book ${named} to ${givenName(input)}.`;
      default:
        return (
          `Delete the address book ${named}, which holds no card. No contact card is destroyed ` +
          "by this; the book itself does not come back."
        );
    }
  },
  precheck: async (input, context) => {
    const books = await resolveBooks(context);
    const target = input.bookId === undefined ? undefined : byId(books, input.bookId);

    if (input.bookId !== undefined && target === undefined) {
      return (
        `Refused: no address book with id ${input.bookId} is in this account, so there is nothing ` +
        `to ${input.action}. Run contacts_search to see the books the account holds — it names ` +
        `${describeBooks(books)}.`
      );
    }

    if (input.action === "delete" && target !== undefined) {
      return refuseImpossibleDelete(target, books, context);
    }

    return refuseDuplicateName(input, target, books);
  },
  run: async (input, context) => {
    const args = requestFor(input, context.session.accountId);

    const response = await context.client.request<SetResponse<AddressBook>>(
      [CAPABILITY_CORE, CAPABILITY_CONTACTS],
      ["AddressBook/set", args, "0"],
    );

    return { text: describeOutcome(input, response) };
  },
});

type Input = z.infer<typeof inputSchema>;

/** One object per call, and the non-cascade written out on every one of them. */
function requestFor(input: Input, accountId: Id): AddressBookSetArguments {
  const base: AddressBookSetArguments = {
    accountId,
    // Stated on every request, not only on the destroying one: a reader of the
    // wire sees on every book write that no card is to be removed. The type
    // makes the omission uncompilable, so no branch can build a set beside this.
    onDestroyRemoveContents: false,
  };

  switch (input.action) {
    case "create":
      return { ...base, create: { [CREATION_KEY]: { name: givenName(input) } } };
    case "rename":
      // The name alone: sending `isDefault` too would move the account's default
      // destination on a call the caller read as a rename.
      return { ...base, update: { [targetId(input)]: { name: givenName(input) } } };
    default:
      return { ...base, destroy: [targetId(input)] };
  }
}

/**
 * The field this action cannot be carried out without, or a throw.
 *
 * `inputSchema` refuses a call that omits it before the handler is reached, so
 * an absent value here means the schema and the code below it have drifted
 * apart. A fallback would answer that drift by destroying an empty id or
 * creating a book with no name; a throw writes nothing at all.
 */
function demand<T>(value: T | undefined, field: string, action: Input["action"]): T {
  if (value === undefined) {
    throw new Error(
      `contacts_book_manage: \`${field}\` is missing on a ${action} call, which the input schema rules out.`,
    );
  }

  return value;
}

/** The book the call acts on, which the schema requires of every action but create. */
function targetId(input: Input): Id {
  return demand(input.bookId, "bookId", input.action);
}

/** The name the call gives a book, which the schema requires of create and rename. */
function givenName(input: Input): string {
  return demand(input.name, "name", input.action);
}

function describeOutcome(input: Input, response: SetResponse<AddressBook>): string {
  switch (input.action) {
    case "create": {
      const refused = response.notCreated?.[CREATION_KEY];
      if (refused !== undefined) return refusedBy(refused);

      const created = response.created?.[CREATION_KEY];
      return `Address book ${givenName(input)} created${created === undefined ? "" : ` (id ${created.id})`}.`;
    }
    case "rename": {
      const id = targetId(input);
      const refused = response.notUpdated?.[id];
      return refused === undefined
        ? `Address book ${id} renamed to ${givenName(input)}.`
        : refusedBy(refused);
    }
    default: {
      const id = targetId(input);
      const refused = response.notDestroyed?.[id];
      return refused === undefined
        ? `Address book ${id} deleted. No contact card was destroyed.`
        : refusedBy(refused);
    }
  }
}

/** The server's own words: it knows things the precheck cannot. */
function refusedBy(error: SetError): string {
  return `Refused by the contacts server: ${error.type}${error.description === undefined ? "" : ` — ${error.description}`}`;
}

/**
 * The three ways deleting a book takes something with it.
 *
 * `onDestroyRemoveContents` is emitted false, so the server would refuse a
 * populated book anyway, but `addressBookHasContents` does not say how many
 * cards are at stake. Counting them here is what makes the refusal actionable.
 */
async function refuseImpossibleDelete(
  target: AddressBook,
  books: readonly AddressBook[],
  context: ToolContext,
): Promise<string | undefined> {
  if (target.isDefault === true) {
    return (
      `Refused: ${target.name} is the default address book of this account, so a card created ` +
      "without a book named would have nowhere to land. Mark another book as the default from " +
      "your contacts client first."
    );
  }

  if (books.length <= 1) {
    return (
      `Refused: ${target.name} is the only address book of this account, and a contact card ` +
      "belongs to at least one book for as long as it exists. Create another book before " +
      "deleting this one."
    );
  }

  const held = await countCards(target.id, context);
  return held === 0
    ? undefined
    : `Refused: the address book ${target.name} holds ${held} contact ${held === 1 ? "card" : "cards"}, ` +
        "and deleting a book never deletes what is in it. Move them to another book with " +
        "contacts_write, or destroy them with contacts_delete, then delete the book.";
}

/**
 * How many cards a book holds, counted without fetching a single one.
 *
 * `limit: 0` with `calculateTotal` asks the server for the count alone: the
 * refusal needs the number, never the cards behind it.
 */
async function countCards(bookId: Id, context: ToolContext): Promise<number> {
  const args: ContactCardQueryArguments = {
    accountId: context.session.accountId,
    filter: { inAddressBook: bookId },
    limit: 0,
    calculateTotal: true,
  };

  const response = await context.client.request<QueryResponse>(
    [CAPABILITY_CORE, CAPABILITY_CONTACTS],
    ["ContactCard/query", args, "0"],
  );

  return response.total ?? response.ids.length;
}

/**
 * Two books sharing a name are indistinguishable in every listing, so the
 * second one is a trap rather than a book.
 */
function refuseDuplicateName(
  input: Input,
  target: AddressBook | undefined,
  books: readonly AddressBook[],
): string | undefined {
  if (!NAMING_ACTIONS.has(input.action)) return undefined;

  const wanted = givenName(input).toLowerCase();
  const clash = books.find((book) => book.id !== target?.id && book.name.toLowerCase() === wanted);

  return clash === undefined
    ? undefined
    : `Refused: an address book named ${clash.name} already exists (id ${clash.id}). Pick another name.`;
}

function byId(books: readonly AddressBook[], bookId: Id): AddressBook | undefined {
  return books.find((book) => book.id === bookId);
}

async function find(
  bookId: Id | undefined,
  context: ToolContext,
): Promise<AddressBook | undefined> {
  if (bookId === undefined) return undefined;
  return byId(await resolveBooks(context), bookId);
}

function describeBooks(books: readonly AddressBook[]): string {
  return books.length === 0
    ? "no address book at all"
    : books.map((book) => `${book.name} (${book.id})`).join(", ");
}
