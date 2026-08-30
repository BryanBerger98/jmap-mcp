/** RFC 8621 — JMAP mail types. Filled in as the domain lands. */

import type { Id } from "./core.js";

/**
 * A folder. JMAP stores the tree as a `parentId` chain and never as a path, so
 * a readable path has to be rebuilt from the whole list.
 *
 * Only the properties `mail_folders` asks for are declared: a field the request
 * never names would be typed as present on a response that never carries it.
 */
export interface Mailbox {
  id: Id;
  name: string;
  parentId: Id | null;
  /** `inbox`, `archive`, `trash`… or `null` for a user-made folder. */
  role: string | null;
  totalEmails: number;
  unreadEmails: number;
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

/** A decoded body, already cut to `maxBodyValueBytes` by the server. */
export interface EmailBodyValue {
  value: string;
  isEncodingProblem: boolean;
  isTruncated: boolean;
}

/** One part of a message body. `partId` keys into `Email.bodyValues`. */
export interface EmailBodyPart {
  partId: string | null;
  blobId: Id | null;
  type: string;
  charset: string | null;
  size: number;
  name: string | null;
}

/**
 * A message.
 *
 * Which properties come back is decided by the `properties` the caller asked
 * for, so anything only `mail_read` requests is optional here: the envelope a
 * search renders never carries a body.
 */
export interface Email {
  id: Id;
  threadId: Id;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  subject: string | null;
  receivedAt: string;
  hasAttachment: boolean;
  size: number;
  preview?: string;
  cc?: EmailAddress[] | null;
  bcc?: EmailAddress[] | null;
  replyTo?: EmailAddress[] | null;
  sentAt?: string | null;
  textBody?: EmailBodyPart[];
  htmlBody?: EmailBodyPart[];
  bodyValues?: Record<string, EmailBodyValue>;
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

export type EmailGetArguments = {
  accountId: Id;
  ids: Id[];
  /** Omitting this makes Stalwart pull `bodyStructure` and every body value. */
  properties?: string[];
  bodyProperties?: string[];
  fetchTextBodyValues?: boolean;
  fetchHTMLBodyValues?: boolean;
  maxBodyValueBytes?: number;
};
