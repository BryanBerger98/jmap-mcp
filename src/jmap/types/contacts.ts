/**
 * JMAP for Contacts (RFC 9610) and the JSContact objects it carries (RFC 9553).
 *
 * Only the read slice is declared: the two tools of the domain search and read,
 * and a property nobody requests would be typed as present on a response that
 * never carries it. `shareWith` and `myRights` stay out for that reason — the
 * sharing module will add them when it reads them.
 */

import type { Id } from "./core.js";

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
