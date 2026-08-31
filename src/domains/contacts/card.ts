/**
 * Contact cards to compact text.
 *
 * `contacts_search` and `contacts_read` render the same card, the same address
 * book legend and the same perimeter mark. Written once here so the two cannot
 * diverge at the first correction, and written without a JMAP client: nothing
 * in this file reads the network.
 */

import { isWithinScope, type RecipientScope } from "../../config/recipients.js";
import type { AddressBook, ContactCard, EmailAddressEntry } from "../../jmap/types/contacts.js";
import type { Id } from "../../jmap/types/core.js";
import { renderFields } from "../../shared/render.js";

/** JSContact card kinds; anything else is rendered as the server spelled it. */
const KIND_INDIVIDUAL = "individual";
export const KIND_GROUP = "group";

/**
 * The one sentence a restricted perimeter owes the reader.
 *
 * The perimeter is resolved once, at startup. A card created during the session
 * is found by the search without being inside it yet, and that gap has to be
 * readable where the mark is, not in a changelog.
 *
 * Served once per answer, by the tool rather than by the block: a sentence
 * repeated under every card stops being read by the time it matters.
 */
export const FROZEN_PERIMETER_NOTE =
  "[perimeter frozen at startup: a card created since is only inside it after a restart]";

/**
 * A name a human can read, whatever the card carries.
 *
 * `name.full` is optional in RFC 9553, so the fallbacks go down to the raw
 * components, then to what identifies the card in practice — its organization,
 * then its address. An empty line is never an acceptable answer here.
 */
export function displayName(card: ContactCard): string {
  const full = card.name?.full?.trim();
  if (full !== undefined && full !== "") return full;

  const recomposed = (card.name?.components ?? [])
    // `separator` components carry punctuation, not name parts.
    .filter((component) => component.kind !== "separator" && component.value.trim() !== "")
    .map((component) => component.value.trim())
    .join(" ");
  if (recomposed !== "") return recomposed;

  const organization = firstValue(card.organizations, (entry) => entry.name);
  if (organization !== undefined) return organization;

  return primaryEmail(card) ?? "(unnamed)";
}

/**
 * The address the card prefers, or its first one.
 *
 * JSContact ranks preference from 1 upwards, 1 being the strongest, and an
 * entry without `pref` is the least preferred of all. Sorting ascending with an
 * absent rank pushed to the end gives both rules at once, and a card where
 * nobody stated a preference keeps its declaration order.
 */
export function primaryEmail(card: ContactCard): string | undefined {
  const entries = Object.values(card.emails ?? {}).filter((entry) => entry.address.trim() !== "");
  if (entries.length === 0) return undefined;

  const ranked = [...entries].sort((left, right) => rankOf(left) - rankOf(right));
  return ranked[0]?.address;
}

function rankOf(entry: EmailAddressEntry): number {
  return entry.pref ?? Number.POSITIVE_INFINITY;
}

/**
 * The properties both renderers below need from `AddressBook/get`.
 *
 * Declared here rather than at each call site: `renderBooks` and `bookNames`
 * read exactly these fields, so the set belongs next to them and cannot drift
 * from one tool to the other.
 */
export const BOOK_PROPERTIES = ["id", "name", "isDefault"] as const;

/**
 * The legend a search puts in its header: which books exist, and their ids.
 *
 * The id is what `contacts_search` takes back as `addressBookId`, so naming a
 * book without it would describe a filter the caller cannot express.
 */
export function renderBooks(books: readonly AddressBook[]): string {
  if (books.length === 0) return "Address books: (none)";

  const listed = books
    .map((book) => `${book.name} (${book.id}${book.isDefault === true ? ", default" : ""})`)
    .join(", ");

  return `Address books: ${listed}`;
}

/**
 * The books one card sits in, by name.
 *
 * A book the `get` did not return is rendered as its raw id: inventing a name
 * for it would read as a real book, and the id at least resolves.
 */
export function bookNames(card: ContactCard, byId: Map<Id, AddressBook>): string[] {
  return Object.keys(card.addressBookIds ?? {}).map((id) => byId.get(id)?.name ?? id);
}

/**
 * Whether this address may be written to, or nothing when nothing restricts it.
 *
 * `undefined` on an open perimeter, so the caller drops the column rather than
 * rendering it empty on every row.
 */
export function scopeMark(address: string, scope: RecipientScope): string | undefined {
  switch (scope.kind) {
    case "anyone":
      return undefined;
    case "restricted":
      return isWithinScope(address, scope) ? "in perimeter" : "outside perimeter";
    case "empty":
      return "outside perimeter (perimeter is empty)";
    case "unreadable":
      return `outside perimeter (${scope.reason})`;
  }
}

/**
 * Which sides of the perimeter the addresses of one card land on.
 *
 * A row shows a single address, so a card whose other addresses sit on the
 * other side of the line has to be able to say so: judging the card on its
 * primary address alone would have the two contacts tools disagree about it.
 * Written over `isWithinScope`, like every other membership question here.
 */
export function addressSides(
  card: ContactCard,
  scope: RecipientScope,
): { anyInside: boolean; anyOutside: boolean } {
  const addresses = Object.values(card.emails ?? {})
    .map((entry) => entry.address)
    .filter((address) => address.trim() !== "");

  return {
    anyInside: addresses.some((address) => isWithinScope(address, scope)),
    anyOutside: addresses.some((address) => !isWithinScope(address, scope)),
  };
}

/** The detail block of one card. Empty fields are dropped, never padded. */
export function renderCard(
  card: ContactCard,
  byId: Map<Id, AddressBook>,
  scope: RecipientScope,
): string {
  const books = bookNames(card, byId);

  return renderFields({
    id: card.id,
    name: displayName(card),
    // Stated only when it is not a person: every other kind changes how the
    // rest of the block should be read.
    kind: card.kind === undefined || card.kind === KIND_INDIVIDUAL ? "" : card.kind,
    uid: card.uid,
    nicknames: joinValues(card.nicknames, (entry) => entry.name),
    organization: joinValues(card.organizations, (entry) => entry.name),
    title: joinValues(card.titles, (entry) => entry.name),
    emails: renderEmails(card, scope),
    phones: joinValues(card.phones, (entry) => entry.number),
    online: joinValues(card.onlineServices, (entry) => entry.uri ?? entry.user ?? entry.service),
    addresses: joinValues(card.addresses, (entry) => entry.full),
    notes: joinValues(card.notes, (entry) => entry.note),
    members: renderMembers(card),
    books: books.join(", "),
    created: card.created,
    updated: card.updated,
  });
}

/**
 * The members of a group, as the uids the card holds.
 *
 * A group is rendered as it stands: unfolding it into its member cards is the
 * business of the module that manipulates them, and here it would only buy an
 * extra round trip.
 */
function renderMembers(card: ContactCard): string {
  if (card.kind !== KIND_GROUP) return "";

  const uids = Object.keys(card.members ?? {});
  return uids.length === 0 ? "0" : `${uids.length} (${uids.join(", ")})`;
}

function renderEmails(card: ContactCard, scope: RecipientScope): string {
  return Object.values(card.emails ?? {})
    .filter((entry) => entry.address.trim() !== "")
    .map((entry) => {
      const mark = scopeMark(entry.address, scope);
      return mark === undefined ? entry.address : `${entry.address} [${mark}]`;
    })
    .join(", ");
}

function joinValues<T>(
  entries: Record<string, T> | undefined,
  read: (entry: T) => string | undefined,
): string {
  return Object.values(entries ?? {})
    .map(read)
    .filter((value): value is string => value !== undefined && value.trim() !== "")
    .join(", ");
}

function firstValue<T>(
  entries: Record<string, T> | undefined,
  read: (entry: T) => string | undefined,
): string | undefined {
  for (const entry of Object.values(entries ?? {})) {
    const value = read(entry)?.trim();
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}
