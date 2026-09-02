/**
 * RFC 9670 — JMAP Sharing: principals, and the notifications a share raises.
 *
 * Three things this file refuses to make representable, each of them a rule the
 * server enforces by silence rather than by an error:
 *
 * - **No sort on `ShareNotification/query`.** The server parses a `created`
 *   comparator and then never applies it: the results come out of a change-log
 *   scan in descending change id (`share_notification/query.rs`). A request that
 *   named a sort would get an order it did not ask for, so no sort is declared.
 * - **No logical operators in the filter.** `AND`, `OR` and `NOT` are rejected
 *   as `unsupportedFilter`, so the filter is a flat object of conditions and the
 *   four the server executes are the only four declared.
 * - **`objectType` is a closed union.** A JMAP id says nothing about the type it
 *   names, and every branch that reads rights has to switch on this value. A
 *   fifth member would compile and would then reach a rights vocabulary that
 *   does not exist.
 *
 * What the server fills differently from what the RFC suggests is noted where it
 * matters, on each type.
 */

import type { CalendarRights } from "./calendars.js";
import type { AddressBookRights } from "./contacts.js";
import type { Id } from "./core.js";
import type { FilesRights } from "./filenode.js";
import type { MailboxRights } from "./mail.js";

/** The four object types that carry a `shareWith` map. */
export const SHAREABLE_TYPES = ["Mailbox", "Calendar", "AddressBook", "FileNode"] as const;

export type ShareableType = (typeof SHAREABLE_TYPES)[number];

/** The rights vocabulary each shareable type answers in. Nothing is shared but `mayShare`. */
export interface RightsByType {
  Mailbox: MailboxRights;
  Calendar: CalendarRights;
  AddressBook: AddressBookRights;
  FileNode: FilesRights;
}

/** The rights of one shareable type, picked by the type itself. */
export type RightsFor<T extends ShareableType> = RightsByType[T];

/**
 * Someone a share can name: an account or a group.
 *
 * Stalwart returns `individual` for a user account and `group` for everything
 * else — `principal/get.rs` has no third branch — so the two other values
 * RFC 9670 defines never arrive.
 *
 * Two properties are worth knowing before rendering one:
 *
 * - `name` and `email` are the same string. Both are filled from the account's
 *   login name; only `description` carries a human-chosen label, and it is null
 *   whenever the directory has none.
 * - `timeZone` is in the RFC and is never rendered by this server, so it is
 *   always absent rather than null.
 */
export interface Principal {
  id: Id;
  type?: "individual" | "group";
  /** The account login, not a display name. */
  name?: string;
  description?: string | null;
  /** The account login again: the same value as `name`. */
  email?: string;
  /** Declared by the RFC, never rendered by this server. */
  timeZone?: string | null;
  capabilities?: Record<string, unknown>;
}

/** Who changed a share, as a notification reports them. */
export interface ShareNotificationChangedBy {
  principalId: Id;
  /**
   * The directory description, falling back to the login — `share_notification/get.rs`.
   * It is therefore either a free-text label or the very string `email` already
   * carries, which is why the address is what gets rendered.
   */
  name?: string;
  /** The account login. The only identifier here that always means one account. */
  email?: string;
}

/**
 * One change to what this account may reach in someone else's account.
 *
 * `oldRights` and `newRights` are complete: the server writes every right of the
 * object's type, granted or not, so a comparison between the two is total and
 * never has to guess at an absent key.
 *
 * The object's own `name` is unreachable. The property parser routes the string
 * `name` to `changedBy/name`, so nothing can ask for it — hence no `name` here.
 */
export interface ShareNotification<T extends ShareableType = ShareableType> {
  id: Id;
  created?: string;
  changedBy?: ShareNotificationChangedBy;
  objectType?: T;
  objectAccountId?: Id;
  objectId?: Id;
  oldRights?: RightsFor<T>;
  newRights?: RightsFor<T>;
}

export type PrincipalGetArguments = {
  accountId: Id;
  /** `null` asks for every principal the directory exposes. */
  ids?: Id[] | null;
  properties?: string[] | null;
};

/**
 * The five conditions `Principal/query` executes.
 *
 * `name` and `email` are the same lookup: both route to an exact login search
 * (`principal/query.rs`), so neither is a substring match and a partial address
 * finds nothing rather than a shortlist. `text` is the only loose one.
 *
 * The whole method is the one this domain can be refused on principle: an
 * instance that leaves directory queries off answers `forbidden` instead of an
 * empty list, and that refusal is a different fact from "no such account".
 */
export type PrincipalFilter = {
  /** An exact account login, not a fragment of one. */
  name?: string;
  /** The same lookup as `name`, under the name a caller reaches for. */
  email?: string;
  text?: string;
  type?: "individual" | "group";
  accountIds?: Id[];
};

/** No `sort`: the server applies no comparator to this query either. */
export type PrincipalQueryArguments = {
  accountId: Id;
  filter?: PrincipalFilter;
  position?: number;
  limit?: number;
  calculateTotal?: boolean;
};

export type ShareNotificationGetArguments = {
  accountId: Id;
  ids?: Id[] | null;
  properties?: string[] | null;
};

/**
 * The four conditions `ShareNotification/query` executes.
 *
 * A fifth would not be ignored the way a file condition is: the server answers
 * `unsupportedFilter` and names it. The list is closed anyway, so the refusal
 * never has to be handled.
 */
export type ShareNotificationFilter = {
  after?: string;
  before?: string;
  objectType?: ShareableType;
  objectAccountId?: Id;
};

/** No `sort`: see the header. The server's order is the only one there is. */
export type ShareNotificationQueryArguments = {
  accountId: Id;
  filter?: ShareNotificationFilter;
  position?: number;
  limit?: number;
  calculateTotal?: boolean;
};
