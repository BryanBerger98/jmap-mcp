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
