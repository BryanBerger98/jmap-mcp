/**
 * A share, written out so someone can arbitrate on it.
 *
 * Two things are rendered here: an object and who reaches it, and a notification
 * saying what someone else opened or closed. Both come down to a set of rights,
 * and a right is only readable in the vocabulary of its own type. `mayWriteAll`
 * on a calendar and `mayWrite` on an address book are not the same permission
 * with two names, so nothing is translated towards a common set and no right is
 * ever rendered in another type's wording.
 *
 * Silence is never an answer. An object nobody reaches says so in a sentence,
 * because an empty list is indistinguishable from a read that came back partial,
 * and "nobody has access" is exactly the claim a person acts on.
 *
 * Nothing here touches the network: names arrive already resolved, as a
 * `PrincipalDirectory`.
 */

import type { Id } from "../../jmap/types/core.js";
import type { ShareableType, ShareNotification } from "../../jmap/types/sharing.js";
import { renderFields } from "../../shared/render.js";
import { CLOSED_DIRECTORY_NOTE, type PrincipalDirectory } from "./principal.js";
import { describeRights, rightsOf } from "./rights.js";
import { displayNameOf, shareTarget } from "./target.js";

/** A rights map as it comes off the wire: every name a boolean, none of them certain. */
export type RightsMap = Readonly<Record<string, boolean | undefined>>;

/**
 * What a shareable object looks like once read for its sharing alone.
 *
 * Structural rather than a union of the four object types: the four differ in
 * everything but the three properties this domain asks for, and a switch here
 * would say four times what the target table already says once.
 */
export interface SharedObject {
  id: Id;
  name?: string;
  shareWith?: Readonly<Record<Id, RightsMap>> | null;
  myRights?: RightsMap;
}

/** An object, who reaches it, and with which rights. */
export function renderSharedObject(
  type: ShareableType,
  object: SharedObject,
  directory: PrincipalDirectory,
): string {
  const { noun } = shareTarget(type);
  const name = displayNameOf(type, object as unknown as Readonly<Record<string, unknown>>);
  const heading = `${noun} ${name === undefined ? object.id : `"${name}" (${object.id})`}`;

  const entries = Object.entries(object.shareWith ?? {});
  const lines = [heading];

  const warning = shareWarning(noun, object.myRights);
  if (warning !== undefined) lines.push(`  ${warning}`);

  if (entries.length === 0) {
    // The sentence is the point: an empty block would read the same as a read
    // that never returned the property.
    lines.push(`  Shared with nobody: no other account reaches this ${noun}.`);
    return lines.join("\n");
  }

  lines.push(`  Shared with ${entries.length} account(s):`);
  for (const [principalId, rights] of entries) {
    lines.push(`  - ${renderBeneficiary(type, principalId, rights, directory)}`);
  }

  return lines.join("\n");
}

/** One beneficiary and everything they may do, on one line. */
export function renderBeneficiary(
  type: ShareableType,
  principalId: Id,
  rights: RightsMap,
  directory: PrincipalDirectory,
): string {
  const granted = describeRights(type, rights);
  const who = directory.nameOf(principalId);

  return granted.length === 0
    ? `${who}: no right granted, so this entry opens nothing`
    : `${who}: ${granted.join("; ")}`;
}

/**
 * What the account may not do to this object's sharing, or nothing.
 *
 * Said on the read rather than kept for the write: a listing that shows a share
 * without saying it cannot be changed invites a call the server will refuse.
 * Never a refusal of its own — reading who has access is allowed regardless.
 */
function shareWarning(noun: string, myRights: RightsMap | undefined): string | undefined {
  if (myRights === undefined || myRights.mayShare === true) return undefined;

  return `mayShare is not granted on this ${noun}: the account can read who reaches it, but the server will refuse a change to its sharing.`;
}

/** A notification: who changed what, and which rights moved. */
export function renderNotification(
  notification: ShareNotification,
  directory: PrincipalDirectory,
): string {
  const { changedBy, objectType, objectId, objectAccountId, created } = notification;

  // `changedBy.name` is never rendered: the server fills it from the directory
  // description and falls back to the login, so it is either a label already
  // carried by the address or the address itself. The address is what names an
  // account without ambiguity.
  const who = changedBy === undefined ? "someone" : directory.nameOf(changedBy.principalId);

  const header = renderFields({
    when: created,
    who,
    object: objectType === undefined ? objectId : `${objectType} ${objectId}`,
    "in account": objectAccountId,
  });

  return `${header}\n${renderRightsChange(notification)}`;
}

/** The two directions a notification can move, each in the type's own wording. */
function renderRightsChange(notification: ShareNotification): string {
  const { objectType, oldRights, newRights } = notification;

  if (objectType === undefined) {
    // Optional in the type, always filled by this server. Rendering the rights
    // anyway would mean picking a vocabulary at random.
    return "  The notification names no object type, so its rights cannot be read.";
  }

  // The typed rights of a notification are the vocabulary of `objectType`; the
  // comparison reads them by name, which every one of the four vocabularies is.
  const { gained, lost } = compareRights(
    objectType,
    oldRights as RightsMap | undefined,
    newRights as RightsMap | undefined,
  );
  const lines: string[] = [];

  if (gained.length > 0) lines.push(`  gained: ${gained.join("; ")}`);
  if (lost.length > 0) lines.push(`  lost: ${lost.join("; ")}`);

  return lines.length === 0
    ? "  No right moved: the two sides of the notification grant the same thing."
    : lines.join("\n");
}

/**
 * What one side grants that the other does not, in the server's order.
 *
 * Both maps are complete on this server — every right of the type is written,
 * granted or not — so an absent name means the read did not carry the map at
 * all, and treating it as ungranted is the only reading available.
 */
export function compareRights(
  type: ShareableType,
  oldRights: RightsMap | undefined,
  newRights: RightsMap | undefined,
): { gained: string[]; lost: string[] } {
  const gained = describeRights(
    type,
    Object.fromEntries(
      rightsOf(type).map((name) => [
        name,
        newRights?.[name] === true && oldRights?.[name] !== true,
      ]),
    ),
  );
  const lost = describeRights(
    type,
    Object.fromEntries(
      rightsOf(type).map((name) => [
        name,
        oldRights?.[name] === true && newRights?.[name] !== true,
      ]),
    ),
  );

  return { gained, lost };
}

/** The note a closed directory owes every rendering that names an id. */
export function directoryNote(directory: PrincipalDirectory): string | undefined {
  return directory.closed ? CLOSED_DIRECTORY_NOTE : undefined;
}
