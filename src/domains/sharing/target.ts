/**
 * The four shareable objects, and everything that differs between them.
 *
 * A JMAP id says nothing about the type it names, so the caller states the type
 * and this table answers the rest: which method reads the object, which one
 * writes it, which capability the server has to advertise for either to exist,
 * which rights vocabulary applies, and which properties are worth asking for.
 *
 * Keeping it a table rather than four branches per tool is the point. Two tools
 * read it, and a fifth shareable type would be one row here instead of a switch
 * in each of them.
 *
 * The composition is static: the tool list is fixed before the session connects,
 * so the schema cannot shrink to hide a type whose capability is missing. The
 * refusal happens at call time instead, and it names the capability.
 *
 * This module makes no call. It describes a target; reading one is the sharing
 * tools' business.
 */

import type { JmapSession } from "../../jmap/session.js";
import {
  CAPABILITY_CALENDARS,
  CAPABILITY_CONTACTS,
  CAPABILITY_FILENODE,
  CAPABILITY_MAIL,
} from "../../jmap/types/core.js";
import { SHAREABLE_TYPES, type ShareableType } from "../../jmap/types/sharing.js";
import { rightsOf } from "./rights.js";

export interface ShareTarget {
  type: ShareableType;
  /** What the object is called in a sentence a person reads. */
  noun: string;
  getMethod: string;
  setMethod: string;
  /** The capability the server has to advertise for the two methods to exist. */
  capability: string;
  /** The property carrying the object's display name. */
  displayNameProperty: string;
  /**
   * What a share read asks for: the id, the display name, and the two sharing
   * properties. Never the object's contents — this domain reads who may reach
   * an object, not what is inside it.
   */
  properties: readonly string[];
  /** The rights this type knows, in the server's order. */
  rights: readonly string[];
}

function target(
  type: ShareableType,
  noun: string,
  capability: string,
  displayNameProperty: string,
): ShareTarget {
  return {
    type,
    noun,
    getMethod: `${type}/get`,
    setMethod: `${type}/set`,
    capability,
    displayNameProperty,
    properties: ["id", displayNameProperty, "shareWith", "myRights"],
    rights: rightsOf(type),
  };
}

export const SHARE_TARGETS: Record<ShareableType, ShareTarget> = {
  Mailbox: target("Mailbox", "folder", CAPABILITY_MAIL, "name"),
  Calendar: target("Calendar", "calendar", CAPABILITY_CALENDARS, "name"),
  AddressBook: target("AddressBook", "address book", CAPABILITY_CONTACTS, "name"),
  FileNode: target("FileNode", "file or folder", CAPABILITY_FILENODE, "name"),
};

/** The four targets, in the order the schema offers them. */
export const SHARE_TARGET_LIST: readonly ShareTarget[] = SHAREABLE_TYPES.map(
  (type) => SHARE_TARGETS[type],
);

export function shareTarget(type: ShareableType): ShareTarget {
  return SHARE_TARGETS[type];
}

/**
 * The refusal for a type this server cannot serve, or nothing.
 *
 * The manifest gates on `principals`, which only proves the notification
 * methods exist. Nothing at the session level says a share will land, and a
 * `FileNode/get` on a server without `filenode` fails on the first call with an
 * error about an unknown method. Naming the capability turns that into a
 * sentence about this server rather than about this request.
 */
export function requireCapability(type: ShareableType, session: JmapSession): string | undefined {
  const { capability, noun } = SHARE_TARGETS[type];
  if (session.has(capability)) {
    return undefined;
  }

  return `This server does not advertise ${capability}, so it shares no ${noun}. Sharing a ${type} needs that capability.`;
}

/** The object's display name, or nothing when the read did not carry it. */
export function displayNameOf(
  type: ShareableType,
  object: Readonly<Record<string, unknown>>,
): string | undefined {
  const value = object[SHARE_TARGETS[type].displayNameProperty];

  return typeof value === "string" ? value : undefined;
}

/**
 * How an object is named in a sentence someone reads: the name and the id, or
 * the id alone when the read carried no name.
 *
 * The id is never dropped. It is what a follow-up call is written in, and a name
 * on its own would leave the reader with nothing to pass back.
 *
 * The parameter stays a plain record rather than `SharedObject`: that type lives
 * in `grant.ts`, which already imports this module, and naming it here would
 * close the cycle.
 */
export function nameOrId(type: ShareableType, object: Readonly<Record<string, unknown>>): string {
  const id = String(object.id);
  const name = displayNameOf(type, object);

  return name === undefined ? id : `"${name}" (${id})`;
}
