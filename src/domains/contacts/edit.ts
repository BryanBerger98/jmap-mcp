/**
 * What writing to an address book takes, shared by the tools that do it.
 *
 * The piece that matters here is `buildPatch`: a pure function of a card as it
 * was read and of a normalized request, returning the `PatchObject` to send. It
 * exists so that what nobody named stays untouched — an object written whole
 * would erase every property the read did not hand back, and a JSContact entry
 * carries `contexts` and `pref` that no rendering of this server shows.
 *
 * Nothing above `buildPatch` reads the network, exactly as the recipient
 * perimeter does not: the rule that protects a card is testable without a server.
 */

import { isWithinScope, type RecipientScope } from "../../config/recipients.js";
import type {
  AddressBook,
  AddressBookGetArguments,
  ContactCard,
  ContactCardGetArguments,
  PatchObject,
} from "../../jmap/types/contacts.js";
import type { GetResponse, Id, SetError, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CONTACTS, CAPABILITY_CORE } from "../../jmap/types/core.js";
import type { ToolContext } from "../../registry/define-tool.js";
import { renderTable } from "../../shared/render.js";
import { BOOK_PROPERTIES } from "./card.js";

/**
 * One read per handler invocation, whichever hook asks for it first.
 *
 * Exported because a tool that needs the books *and* the cards asks for both in
 * one request and seeds this key with half the answer: the cache is what makes
 * the two reads one round trip instead of two.
 */
export const BOOKS_KEY = "contacts:books";

/** The properties a patch needs to see before it can be built. */
export const EDITABLE_PROPERTIES = [
  "id",
  "kind",
  "uid",
  "name",
  "nicknames",
  "organizations",
  "titles",
  "emails",
  "phones",
  "notes",
  "members",
  "addressBookIds",
] as const;

/** What a set of members or coordinates gains and loses. */
export interface AddRemove<T> {
  add?: readonly T[] | undefined;
  remove?: readonly T[] | undefined;
}

/**
 * One write request, normalized: what to put on the card, in the caller's terms.
 *
 * Coordinates come as `add` and `remove` rather than as a replacement list, and
 * a removal names the value to drop rather than the internal key that holds it:
 * those keys are opaque, and no tool of this server ever shows them.
 */
export interface CardEdit {
  name?: string | undefined;
  organization?: string | undefined;
  title?: string | undefined;
  nickname?: string | undefined;
  note?: string | undefined;
  kind?: string | undefined;
  emails?: AddRemove<string> | undefined;
  phones?: AddRemove<string> | undefined;
  /** `set` replaces the membership whole; `add` and `remove` amend it. */
  addressBooks?: ({ set?: readonly Id[] | undefined } & AddRemove<Id>) | undefined;
  /** Keyed by uid on the wire: these are the uids, already resolved. */
  members?: AddRemove<string> | undefined;
}

/**
 * The patch one card is to receive, keyed by JSON pointer.
 *
 * Per family, the shape follows what the card already carries, because RFC 8620
 * §5.3 requires every segment of a pointer but the last to exist:
 *
 * - the parent map is there   → a leaf pointer, `emails/work/address`
 * - the parent map is absent  → the map whole, `emails`, which creates nothing else
 *
 * The two are never both emitted for one family: a patch that is the prefix of
 * another is invalid, and the server would answer `invalidPatch` to a request we
 * already knew was malformed.
 */
export function buildPatch(card: ContactCard, edit: CardEdit): PatchObject {
  const patch: PatchObject = {};

  if (edit.kind !== undefined) patch.kind = edit.kind;

  if (edit.name !== undefined) {
    // `name` is a single object, not a map: there is no key to invent.
    if (card.name === undefined) patch.name = { full: edit.name };
    else patch["name/full"] = edit.name;
  }

  patchEntry(patch, card.organizations, "organizations", "name", edit.organization);
  patchEntry(patch, card.titles, "titles", "name", edit.title);
  patchEntry(patch, card.nicknames, "nicknames", "name", edit.nickname);
  patchEntry(patch, card.notes, "notes", "note", edit.note);

  patchCoordinates(patch, card.emails, "emails", "address", (entry) => entry.address, edit.emails);
  patchCoordinates(patch, card.phones, "phones", "number", (entry) => entry.number, edit.phones);

  patchMembership(patch, card.addressBookIds, "addressBookIds", edit.addressBooks);
  patchMembership(patch, card.members, "members", edit.members);

  refusePrefixCollision(patch);
  return patch;
}

/**
 * The object a creation sends: a whole JSContact, since nothing exists to keep.
 *
 * `addressBookIds` is always populated. A card belongs to at least one address
 * book for as long as it exists (RFC 9610 §3), and no book is assigned in place
 * of an absent one.
 */
export function buildCreation(edit: CardEdit, bookIds: readonly Id[]): Partial<ContactCard> {
  const created: Partial<ContactCard> = {
    addressBookIds: Object.fromEntries(bookIds.map((id) => [id, true])),
  };

  if (edit.kind !== undefined) created.kind = edit.kind;
  if (edit.name !== undefined) created.name = { full: edit.name };
  if (edit.organization !== undefined) created.organizations = { o1: { name: edit.organization } };
  if (edit.title !== undefined) created.titles = { t1: { name: edit.title } };
  if (edit.nickname !== undefined) created.nicknames = { n1: { name: edit.nickname } };
  if (edit.note !== undefined) created.notes = { no1: { note: edit.note } };

  const emails = edit.emails?.add ?? [];
  if (emails.length > 0) {
    created.emails = Object.fromEntries(
      emails.map((address, index) => [`e${index + 1}`, { address }]),
    );
  }

  const phones = edit.phones?.add ?? [];
  if (phones.length > 0) {
    created.phones = Object.fromEntries(
      phones.map((number, index) => [`p${index + 1}`, { number }]),
    );
  }

  const members = edit.members?.add ?? [];
  if (members.length > 0) {
    created.members = Object.fromEntries(members.map((uid) => [uid, true]));
  }

  return created;
}

/**
 * The books the card sits in once the edit is applied.
 *
 * Computed rather than read off the patch: `contacts_write` refuses an edit that
 * would leave a card in no book at all, and that verdict has to be reachable
 * before anything is written.
 */
export function resultingBooks(card: ContactCard, edit: CardEdit): Set<Id> {
  const asked = edit.addressBooks;
  if (asked?.set !== undefined) return new Set(asked.set);

  const books = new Set(
    Object.entries(card.addressBookIds ?? {})
      .filter(([, member]) => member)
      .map(([id]) => id),
  );

  for (const id of asked?.add ?? []) books.add(id);
  for (const id of asked?.remove ?? []) books.delete(id);

  return books;
}

/**
 * Every address book of the account, read once per handler invocation.
 *
 * The whole list rather than the one book a call names: naming a book, refusing
 * an unknown one and finding the default all need the neighbours, and asking for
 * them one by one would spend a round trip each time.
 */
export function resolveBooks(context: ToolContext): Promise<AddressBook[]> {
  return context.once(BOOKS_KEY, async () => {
    const args: AddressBookGetArguments = {
      accountId: context.session.accountId,
      ids: null,
      properties: [...BOOK_PROPERTIES],
    };

    const response = await context.client.request<GetResponse<AddressBook>>(
      [CAPABILITY_CORE, CAPABILITY_CONTACTS],
      ["AddressBook/get", args, "0"],
    );

    return response.list;
  });
}

/**
 * The book a creation lands in when the caller named none, or nothing.
 *
 * RFC 9610 §2 says at most one book carries `isDefault`, and only *should* say
 * that one does. An account where none does and several books exist has no
 * answer here, and picking one of them would file a card somewhere nobody chose:
 * the caller is asked instead.
 */
export function defaultBook(books: readonly AddressBook[]): AddressBook | undefined {
  const marked = books.find((book) => book.isDefault === true);
  if (marked !== undefined) return marked;

  return books.length === 1 ? books[0] : undefined;
}

/**
 * The books of the account, named and identified, for a refusal to point at.
 *
 * Structurally typed rather than over `AddressBook`: the wording is the same
 * whichever tool refuses, and two copies of one sentence drift at the first edit.
 */
export function describeBooks(books: readonly { id: Id; name: string }[]): string {
  return books.length === 0
    ? "no address book at all"
    : books.map((book) => `${book.name} (${book.id})`).join(", ");
}

/**
 * The uid of each card id, which is what `members` is keyed by.
 *
 * RFC 9553 §2.1.9 keys a group's members by uid, and `contacts_search` hands out
 * JMAP ids: requiring a uid from the caller would mean reading every member card
 * first, which is exactly what this does once, in one call.
 */
export async function resolveUids(
  context: ToolContext,
  cardIds: readonly Id[],
): Promise<Map<Id, string>> {
  if (cardIds.length === 0) return new Map();

  const args: ContactCardGetArguments = {
    accountId: context.session.accountId,
    ids: [...cardIds],
    properties: ["id", "uid"],
  };

  const response = await context.once(`contacts:uids:${[...cardIds].sort().join(",")}`, () =>
    context.client.request<GetResponse<ContactCard>>(
      [CAPABILITY_CORE, CAPABILITY_CONTACTS],
      ["ContactCard/get", args, "0"],
    ),
  );

  return new Map(
    response.list
      .filter((card): card is ContactCard & { uid: string } => card.uid !== undefined)
      .map((card) => [card.id, card.uid]),
  );
}

/**
 * Accounts for a `ContactCard/set`, id by id.
 *
 * `done` reads as a past participle — "updated", "destroyed" — so one rendering
 * serves every tool. An id absent from the refusals counts as done: the server
 * names what it refused, and reading success off `updated` instead would report
 * a card as untouched on a server that answers with a null patch.
 */
export function describeCardOutcome(
  response: SetResponse<unknown>,
  ids: readonly Id[],
  done: string,
  half: "updated" | "destroyed" = "updated",
): string {
  const refused = (half === "updated" ? response.notUpdated : response.notDestroyed) ?? {};

  const rows = ids.map((id) => {
    const error = refused[id];
    return { id, outcome: error === undefined ? done : `refused: ${describeSetError(error)}` };
  });

  // Counted off the server's answer, never off the cell rendered from it: a
  // `done` wording that happened to read like a refusal would move the headline.
  const failed = ids.filter((id) => refused[id] !== undefined).length;
  const succeeded = rows.length - failed;

  const headline =
    failed === 0
      ? `${succeeded} contact ${plural(succeeded)} ${done}.`
      : succeeded === 0
        ? `No contact card was ${done}: the server refused all ${rows.length}.`
        : `${succeeded} of ${rows.length} contact cards ${done}, ${failed} refused by the server.`;

  return `${headline}\n\n${renderTable(rows, ["id", "outcome"])}`;
}

/**
 * The sentence an address written outside the perimeter owes its reader.
 *
 * The perimeter is resolved once, at startup: writing an address into an address
 * book widens it only at the next start, and somebody who learns that by being
 * refused a send learns it too late. `undefined` when nothing is restricted, and
 * when every address written is already inside.
 *
 * Written over `isWithinScope`, like every other membership question here: a
 * comparison copied out for display would drift from the refusal it explains.
 */
export function outsidePerimeterNote(
  addresses: readonly string[],
  scope: RecipientScope,
): string | undefined {
  if (scope.kind === "anyone") return undefined;

  const outside = addresses.filter((address) => !isWithinScope(address, scope));
  if (outside.length === 0) return undefined;

  return (
    `Note: ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} outside the recipient ` +
    "perimeter this server resolved at startup, so a send to that address is still refused. " +
    "The perimeter is read once, when the server starts: restart it to pick this card up."
  );
}

/**
 * Patches one field of a keyed entry — an organization's name, a note's text.
 *
 * The first entry of the map is the one corrected: these maps hold a handful of
 * values at most, and choosing among them would need a key the caller has never
 * been shown.
 */
function patchEntry(
  patch: PatchObject,
  existing: Record<string, unknown> | undefined,
  map: string,
  leaf: string,
  value: string | undefined,
): void {
  if (value === undefined) return;

  if (existing === undefined) {
    patch[map] = { [freshKey(new Set(), map)]: { [leaf]: value } };
    return;
  }

  const key = Object.keys(existing)[0];
  if (key === undefined) {
    // The map is there but empty: the last segment is what gets created.
    patch[`${map}/${freshKey(existing, map)}`] = { [leaf]: value };
    return;
  }

  patch[`${map}/${key}/${leaf}`] = value;
}

/**
 * Adds and removes email addresses or phone numbers.
 *
 * An addition never lands on a key already taken, so it cannot overwrite an
 * entry; a removal names the value, and every key carrying it is dropped.
 */
function patchCoordinates<T>(
  patch: PatchObject,
  existing: Record<string, T> | undefined,
  map: string,
  leaf: string,
  read: (entry: T) => string,
  asked: AddRemove<string> | undefined,
): void {
  if (asked === undefined) return;

  const added = asked.add ?? [];

  if (existing === undefined) {
    // Nothing to remove from a family the card does not carry, and nothing to
    // point into either: the map is written whole or not at all.
    if (added.length === 0) return;

    patch[map] = Object.fromEntries(
      added.map((value, index) => [`${map.slice(0, 1)}${index + 1}`, { [leaf]: value }]),
    );
    return;
  }

  const taken = new Set(Object.keys(existing));
  for (const value of added) {
    const key = freshKey(taken, map);
    taken.add(key);
    patch[`${map}/${key}`] = { [leaf]: value };
  }

  for (const value of asked.remove ?? []) {
    const wanted = fold(value);
    for (const [key, entry] of Object.entries(existing)) {
      if (fold(read(entry)) === wanted) patch[`${map}/${key}`] = null;
    }
  }
}

/**
 * Patches a set-shaped map: address book membership, group members.
 *
 * `set` replaces the map whole, which is the one case where writing the whole
 * property is the intent rather than an accident.
 */
function patchMembership(
  patch: PatchObject,
  existing: Record<string, boolean> | undefined,
  map: string,
  asked: ({ set?: readonly Id[] | undefined } & AddRemove<string>) | undefined,
): void {
  if (asked === undefined) return;

  const added = asked.add ?? [];
  const removed = asked.remove ?? [];

  if (asked.set !== undefined) {
    if (added.length > 0 || removed.length > 0) {
      // Stated here rather than left to the collision check below, which only
      // sees it when the card already carries the map: on a card that does not,
      // both branches write the same key and one would silently win.
      throw new Error(
        `contacts: ${map} was asked to be replaced and amended in the same call. Replacing ` +
          "writes the whole property while amending points inside it, and RFC 8620 §5.3 forbids " +
          "one patch being the prefix of another. Do one or the other.",
      );
    }

    patch[map] = Object.fromEntries(asked.set.map((id) => [id, true]));
    return;
  }

  if (existing === undefined) {
    // Nothing to point into, and nothing to remove from either.
    if (added.length > 0) patch[map] = Object.fromEntries(added.map((id) => [id, true]));
    return;
  }

  for (const id of added) patch[`${map}/${id}`] = true;
  for (const id of removed) patch[`${map}/${id}`] = null;
}

/**
 * A key nothing holds yet, so an addition creates rather than replaces.
 *
 * The keys of these maps are opaque per RFC 9553 — only their values carry
 * meaning — so any free key does, and a readable one helps whoever reads the
 * wire.
 */
function freshKey(taken: Set<string> | Record<string, unknown>, map: string): string {
  const held = taken instanceof Set ? taken : new Set(Object.keys(taken));
  const prefix = map.slice(0, 1);

  for (let index = 1; ; index += 1) {
    const candidate = `${prefix}${index}`;
    if (!held.has(candidate)) return candidate;
  }
}

/**
 * Two patches where one is the prefix of the other are invalid (RFC 8620 §5.3).
 *
 * Caught here rather than on the wire: the server would answer `invalidPatch`
 * and write nothing, which is the safe outcome but tells the caller nothing
 * about which two parts of their request contradict each other.
 */
function refusePrefixCollision(patch: PatchObject): void {
  const keys = Object.keys(patch);

  for (const key of keys) {
    const nested = keys.find((other) => other.startsWith(`${key}/`));
    if (nested !== undefined) {
      throw new Error(
        `contacts: the patch would carry both ${key} and ${nested}, and a patch that is the ` +
          "prefix of another is invalid. Replacing a family and amending it in the same call " +
          "cannot both be honoured — do one or the other.",
      );
    }
  }
}

function fold(value: string): string {
  return value.trim().toLowerCase();
}

/** A `SetError` in one line, wherever a refusal has to be read rather than parsed. */
export function describeSetError(error: SetError): string {
  return error.description === undefined ? error.type : `${error.type} — ${error.description}`;
}

function plural(count: number): string {
  return count === 1 ? "card" : "cards";
}
