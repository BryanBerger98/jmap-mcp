/** RFC 8621 — JMAP mail types. Filled in as the domain lands. */

import type { Id } from "./core.js";

/** What the account may do to a mailbox. Read tools only consult `mayReadItems`. */
export interface MailboxRights {
  mayReadItems: boolean;
  mayAddItems: boolean;
  mayRemoveItems: boolean;
  maySetSeen: boolean;
  maySetKeywords: boolean;
  mayCreateChild: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  maySubmit: boolean;
}

/**
 * A folder. JMAP stores the tree as a `parentId` chain and never as a path, so
 * a readable path has to be rebuilt from the whole list.
 */
export interface Mailbox {
  id: Id;
  name: string;
  parentId: Id | null;
  /** `inbox`, `archive`, `trash`… or `null` for a user-made folder. */
  role: string | null;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
  myRights: MailboxRights;
  isSubscribed: boolean;
}

/**
 * Method arguments are type aliases, not interfaces: only an alias gets the
 * implicit index signature that lets it travel as an `Invocation` payload.
 */
export type MailboxGetArguments = {
  accountId: Id;
  /** `null` asks for every mailbox in the account. */
  ids?: Id[] | null;
  properties?: string[] | null;
};

export interface EmailAddress {
  name: string | null;
  email: string;
}

/** A message, cut down to the envelope properties the read tools render. */
export interface Email {
  id: Id;
  threadId: Id;
  mailboxIds: Record<Id, boolean>;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  subject: string | null;
  receivedAt: string;
  preview: string;
  hasAttachment: boolean;
  size: number;
}

/**
 * The handful of RFC 8621 conditions the search exposes, out of the twenty
 * Stalwart runs. Every field set is ANDed by the server.
 */
export type EmailFilterCondition = {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  /**
   * Header name alone, or name and value. Stalwart drops a malformed condition
   * without an error, so a broken tuple silently widens the result set.
   */
  header?: [string] | [string, string];
  inMailbox?: Id;
  before?: string;
  after?: string;
};

export type EmailQueryArguments = {
  accountId: Id;
  filter?: EmailFilterCondition;
  sort?: { property: string; isAscending: boolean }[];
  position?: number;
  limit?: number;
  calculateTotal?: boolean;
};
