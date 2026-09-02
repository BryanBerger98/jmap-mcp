/**
 * The four rights vocabularies, and what each right actually allows.
 *
 * Nothing here is unified. A mailbox has ten rights, a calendar eight, an
 * address book four and a file node six. Only `mayDelete` and `mayShare` appear
 * in all four, and everything that makes a share worth granting is type-specific.
 * Inventing a common vocabulary would mean translating a right into a word the
 * server never parses, and a grant is written with the name the server reads or
 * it is not written at all.
 *
 * The lists are closed, and they are the only defence there is. A right written
 * `false` is ignored without error, and so is an unknown name written `false`
 * (`jmap-tools/src/json/value.rs:236-242`); only an unknown name written `true`
 * raises `invalidProperties`. A typo therefore looks exactly like a grant that
 * worked, which is why an unknown name is refused here before anything is sent.
 *
 * The order is the server's own, not the alphabet: it is the order the rights
 * are declared in `jmap-proto/src/object/{mailbox,calendar,addressbook,file_node}.rs`,
 * so a reader comparing this file against the source reads them in step.
 *
 * Nothing in this module touches the network or knows a JMAP client.
 */

import type { ShareableType } from "../../jmap/types/sharing.js";

/** Ten rights on a folder. */
export const MAILBOX_RIGHTS = [
  "mayReadItems",
  "mayAddItems",
  "mayRemoveItems",
  "maySetSeen",
  "maySetKeywords",
  "mayCreateChild",
  "mayRename",
  "maySubmit",
  "mayDelete",
  "mayShare",
] as const;

/** Eight rights on a calendar. */
export const CALENDAR_RIGHTS = [
  "mayReadFreeBusy",
  "mayReadItems",
  "mayWriteAll",
  "mayWriteOwn",
  "mayUpdatePrivate",
  "mayRSVP",
  "mayShare",
  "mayDelete",
] as const;

/** Four rights on an address book. */
export const ADDRESS_BOOK_RIGHTS = ["mayRead", "mayWrite", "mayShare", "mayDelete"] as const;

/** Six rights on a file node. */
export const FILE_NODE_RIGHTS = [
  "mayRead",
  "mayAddChildren",
  "mayRename",
  "mayDelete",
  "mayModifyContent",
  "mayShare",
] as const;

export type MailboxRight = (typeof MAILBOX_RIGHTS)[number];
export type CalendarRight = (typeof CALENDAR_RIGHTS)[number];
export type AddressBookRight = (typeof ADDRESS_BOOK_RIGHTS)[number];
export type FileNodeRight = (typeof FILE_NODE_RIGHTS)[number];

const VOCABULARY: Record<ShareableType, readonly string[]> = {
  Mailbox: MAILBOX_RIGHTS,
  Calendar: CALENDAR_RIGHTS,
  AddressBook: ADDRESS_BOOK_RIGHTS,
  FileNode: FILE_NODE_RIGHTS,
};

/**
 * What each right allows, in the terms someone arbitrates on.
 *
 * A grant is confirmed by a person reading one sentence, and `maySetKeywords`
 * is not that sentence. Every rendering goes through these, and the property
 * name only ever appears next to its wording, never alone.
 */
const MAILBOX_LABELS = {
  mayReadItems: "read the messages it holds",
  mayAddItems: "put messages into it",
  mayRemoveItems: "take messages out of it",
  maySetSeen: "mark its messages read or unread",
  maySetKeywords: "change any flag on its messages",
  mayCreateChild: "create folders inside it",
  mayRename: "rename it or move it in the tree",
  maySubmit: "send mail from it",
  mayDelete: "delete the folder itself",
  mayShare: "share it onwards with other people",
} as const satisfies Record<MailboxRight, string>;

const CALENDAR_LABELS = {
  mayReadFreeBusy: "see when it is busy, without reading the events",
  mayReadItems: "read its events in full",
  mayWriteAll: "create events and change any of them",
  mayWriteOwn: "create events and change only its own",
  mayUpdatePrivate: "change the private properties of its events",
  mayRSVP: "answer invitations in this calendar",
  mayShare: "share it onwards with other people",
  mayDelete: "delete the calendar itself",
} as const satisfies Record<CalendarRight, string>;

const ADDRESS_BOOK_LABELS = {
  mayRead: "read the cards it holds",
  mayWrite: "create and change its cards",
  mayShare: "share it onwards with other people",
  mayDelete: "delete the address book itself",
} as const satisfies Record<AddressBookRight, string>;

const FILE_NODE_LABELS = {
  mayRead: "read it and download its content",
  mayAddChildren: "create files and folders inside it",
  mayRename: "rename it or move it in the tree",
  mayDelete: "delete it",
  mayModifyContent: "replace its content",
  mayShare: "share it onwards with other people",
} as const satisfies Record<FileNodeRight, string>;

const LABELS: Record<ShareableType, Record<string, string>> = {
  Mailbox: MAILBOX_LABELS,
  Calendar: CALENDAR_LABELS,
  AddressBook: ADDRESS_BOOK_LABELS,
  FileNode: FILE_NODE_LABELS,
};

/** The rights a type knows, in the server's declaration order. */
export function rightsOf(type: ShareableType): readonly string[] {
  return VOCABULARY[type];
}

/** Whether a type knows a right by that name. The server will not say. */
export function isKnownRight(type: ShareableType, name: string): boolean {
  return VOCABULARY[type].includes(name);
}

/**
 * A right and what it allows, never the bare property name.
 *
 * An unknown name is returned as-is rather than thrown on: this renders, and a
 * rendering that throws would lose the rest of a response over one key the
 * server invented after this file was written.
 */
export function rightLabel(type: ShareableType, name: string): string {
  const label = LABELS[type][name];

  return label === undefined ? name : `${name} — ${label}`;
}

/**
 * The refusal for every name the type does not know, or nothing.
 *
 * It names the rights and the type, because the two together are the whole
 * mistake: `mayWriteAll` is a real right, just not one an address book has.
 */
export function refuseUnknownRights(
  type: ShareableType,
  names: readonly string[],
): string | undefined {
  const unknown = names.filter((name) => !isKnownRight(type, name));
  if (unknown.length === 0) {
    return undefined;
  }

  return [
    `${type} has no right named ${unknown.join(", ")}.`,
    `A ${type} knows these: ${VOCABULARY[type].join(", ")}.`,
    "The server ignores an unknown right written false without an error, so this call stops here.",
  ].join(" ");
}

/** The granted rights of a map, labelled, in the server's order. Ungranted ones are left out. */
export function describeRights(
  type: ShareableType,
  rights: Readonly<Record<string, boolean | undefined>> | undefined,
): string[] {
  if (rights === undefined) {
    return [];
  }

  return VOCABULARY[type]
    .filter((name) => rights[name] === true)
    .map((name) => rightLabel(type, name));
}

/**
 * The side effect a named right carries, or nothing.
 *
 * Every right is an alias for a set of internal ACLs, and a read returns `true`
 * only when the whole set is present (`api/acl.rs:196`). Two of those aliases
 * overlap in a way that makes a grant do more, or less, than its name says.
 * Both are stated in whichever direction the call goes: the overlap does not
 * care whether the right is being granted or revoked.
 */
export function linkedRightsNote(
  type: ShareableType,
  names: readonly string[],
): string | undefined {
  if (
    type === "Mailbox" &&
    names.some((name) => name === "maySetSeen" || name === "maySetKeywords")
  ) {
    return "maySetSeen and maySetKeywords are the same permission on this server: touching one touches the other, and a read back cannot tell them apart.";
  }

  if (type === "Calendar" && names.includes("mayDelete")) {
    return "mayWriteAll covers the permission behind mayDelete: revoking mayDelete makes mayWriteAll read back as not granted, and nothing in the response says so.";
  }

  return undefined;
}
