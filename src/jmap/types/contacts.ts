/**
 * JMAP for Contacts (RFC 9610) and the JSContact objects it carries (RFC 9553).
 *
 * Only what the domain reads and writes is declared: a property nobody requests
 * would be typed as present on a response that never carries it. `shareWith` and
 * `myRights` are here now that the sharing domain reads them, and they are
 * optional for the same reason: the contacts tools never ask for them.
 *
 * Two rules of the specification are load-bearing here and are easy to lose:
 *
 * - The keys of `members` are the **uids** of the cards a group holds, never
 *   their JMAP ids (RFC 9553 §2.1.9). The two look alike on the wire and name
 *   different things, and a group written with ids holds nobody.
 * - A card belongs to at least one address book for as long as it exists
 *   (RFC 9610 §3). `addressBookIds` can therefore never be written empty, and no
 *   book is assigned by default in its place.
 */

import type { Id } from "./core.js";

/**
 * What a principal may do to one address book (RFC 9610 §2, RFC 9670 §3).
 *
 * The shortest of the four vocabularies: reading and writing cards are one
 * right each, and no right distinguishes a card the principal created from one
 * it did not.
 */
export interface AddressBookRights {
  mayRead?: boolean;
  mayWrite?: boolean;
  mayShare?: boolean;
  mayDelete?: boolean;
}

/**
 * A named collection of cards.
 *
 * `AddressBook` has no `query` in the RFC: an account holds a handful of books,
 * and `AddressBook/get` with `ids: null` returns them all in one call.
 */
export interface AddressBook {
  id: Id;
  name: string;
  description?: string | null;
  sortOrder?: number;
  isDefault?: boolean;
  isSubscribed?: boolean;
  /** Beneficiary principal id to the rights it holds. Only the sharing domain reads it. */
  shareWith?: Record<Id, AddressBookRights>;
  /** What this account may do to the book, as the server computes it. */
  myRights?: AddressBookRights;
}

/**
 * One email address on a card.
 *
 * `address` is the only property JSContact makes mandatory, which is why the
 * perimeter reads it and nothing else: contexts and preference say where a
 * person prefers to be reached, not whether they may be written to.
 */
export interface EmailAddressEntry {
  address: string;
  contexts?: Record<string, boolean>;
  pref?: number;
}

/** One component of a name: `given`, `surname`, `separator`, and so on. */
export interface NameComponent {
  kind: string;
  value: string;
}

/**
 * A name, whole or in parts.
 *
 * `full` is not guaranteed by RFC 9553: a card may carry only its components,
 * and every reader has to be able to recompose a display name from them.
 */
export interface Name {
  full?: string;
  components?: NameComponent[];
}

export interface Nickname {
  name: string;
  pref?: number;
}

export interface Organization {
  name?: string;
}

export interface TitleEntry {
  name: string;
}

export interface PhoneEntry {
  number: string;
  contexts?: Record<string, boolean>;
  pref?: number;
}

export interface OnlineService {
  service?: string;
  uri?: string;
  user?: string;
}

export interface AddressEntry {
  full?: string;
}

export interface NoteEntry {
  note: string;
}

/**
 * A contact card: a JSContact object plus `id`, `addressBookIds` and `blobId`.
 *
 * The entry-bearing properties are maps keyed by an opaque id rather than lists:
 * the keys carry no meaning here, only the values do. `members` is the one
 * exception — its keys are the uids of the cards a group holds.
 */
export interface ContactCard {
  id: Id;
  kind?: string;
  uid?: string;
  name?: Name;
  nicknames?: Record<string, Nickname>;
  organizations?: Record<string, Organization>;
  titles?: Record<string, TitleEntry>;
  emails?: Record<string, EmailAddressEntry>;
  phones?: Record<string, PhoneEntry>;
  onlineServices?: Record<string, OnlineService>;
  addresses?: Record<string, AddressEntry>;
  notes?: Record<string, NoteEntry>;
  members?: Record<string, boolean>;
  addressBookIds?: Record<Id, boolean>;
  created?: string;
  updated?: string;
}

/**
 * The `ContactCard/query` conditions the domain actually sends.
 *
 * Stalwart wires twenty; these are the ones a search over a personal address
 * book asks for. `name`, `name/given` and `name/surname` fall back on the same
 * index, so only `name` is declared: the other two would promise a precision
 * the server does not have.
 */
export interface ContactCardFilterCondition {
  inAddressBook?: Id;
  uid?: string;
  kind?: string;
  text?: string;
  name?: string;
  email?: string;
  phone?: string;
  organization?: string;
  note?: string;
}

export type ContactCardQueryArguments = {
  accountId: Id;
  filter?: ContactCardFilterCondition;
  /** Stalwart sorts cards on `created` and `updated` only; anything else fails. */
  sort?: { property: string; isAscending: boolean }[];
  position?: number;
  limit?: number;
  calculateTotal?: boolean;
};

export type ContactCardGetArguments = {
  accountId: Id;
  ids?: Id[] | null;
  properties?: string[] | null;
};

export type AddressBookGetArguments = {
  accountId: Id;
  ids?: Id[] | null;
  properties?: string[] | null;
};

/**
 * A patch, as RFC 8620 §5.3 defines it: keys are JSON pointers into the object.
 *
 * Deliberately not a `Partial<ContactCard>`. A patch is not a partial object —
 * `emails/work/address` is one key here and three levels of nesting there — and
 * typing it as one would let a whole `emails` map be sent under a name that
 * reads like a correction while it in fact replaces everything the card held.
 */
export type PatchObject = Record<string, unknown>;

export type ContactCardSetArguments = {
  accountId: Id;
  /** Creation id to object; the server hands back the real id in `created`. */
  create?: Record<Id, Partial<ContactCard>>;
  update?: Record<Id, PatchObject>;
  destroy?: Id[];
};

export type AddressBookSetArguments = {
  accountId: Id;
  create?: Record<Id, Partial<AddressBook>>;
  update?: Record<Id, PatchObject>;
  destroy?: Id[];
  /**
   * Required by this type, optional in the RFC.
   *
   * The specification defaults it to false, and a default is not a guarantee:
   * making it mandatory means an `AddressBook/set` that forgets to state it does
   * not compile, so no write can quietly inherit a server's idea of the answer.
   * True empties the whole book, cards included — this server never sends true.
   */
  onDestroyRemoveContents: boolean;
};
