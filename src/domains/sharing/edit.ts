/**
 * What writing a share takes, and the one place four foreign methods are named.
 *
 * Sharing is the only surface of this project that writes into objects it does
 * not own the domain of. A folder belongs to mail, a calendar to calendars, an
 * address book to contacts, a node to file storage — and yet the property that
 * says who reaches them is written by none of those four. Concentrating the four
 * `/set` names in this single module is what makes that provable: a contract test
 * searches the whole of `src/` for each literal and expects exactly this file
 * outside the type's own domain.
 *
 * Everything a share writes is a `PatchObject` on `shareWith`, never the map. A
 * whole map would be written from what a read returned, and every beneficiary the
 * call never named would ride on that read: one that came back partial, or one
 * taken before someone else granted an access in parallel, silently removes them.
 * The patch names one beneficiary and touches nobody else, which is the entire
 * reason this module has no "write the sharing of" function at all.
 *
 * `ShareNotification/set` is not here. It is the only method of the domain that
 * carries a destroy list, and it belongs to the tool that confirms it rather than
 * to the factory that writes updates — the contract on the file storage reads
 * this file expecting no such key, and it is right to.
 *
 * Nothing here touches the network.
 */

import type { Id, SetResponse } from "../../jmap/types/core.js";
import type { ShareableType } from "../../jmap/types/sharing.js";
import type { BatchSubject } from "../../shared/batch.js";
import { describeSetError, renderTable } from "../../shared/render.js";
import { fileNodeSetArguments } from "../files/edit.js";

/** What a batch of shared objects is made of, for the refusal both branches share. */
export const SHARED_OBJECTS: BatchSubject = {
  noun: "shared object",
  discoveredBy: "sharing_access",
};

/** What a batch of notifications is made of, for the same refusal. */
export const SHARE_NOTIFICATIONS: BatchSubject = {
  noun: "sharing notification",
  discoveredBy: "sharing_access",
};

/**
 * The `/set` method of each shareable type, written out.
 *
 * Literals rather than the `${type}/set` that `target.ts` already builds, and
 * deliberately so. The contract that keeps these four methods out of every other
 * module searches for the quoted string, so a name assembled at runtime would
 * pass a test that exists to catch exactly this file's own mistakes.
 */
const SET_METHODS: Record<ShareableType, string> = {
  Mailbox: "Mailbox/set",
  Calendar: "Calendar/set",
  AddressBook: "AddressBook/set",
  FileNode: "FileNode/set",
};

export function shareSetMethod(type: ShareableType): string {
  return SET_METHODS[type];
}

/**
 * A patch on `shareWith`, keyed by JSON pointer.
 *
 * Two forms, and never both in one call. `shareWith/{principalId}/{right}` set
 * to a boolean moves one right and leaves the rest of that beneficiary's map
 * where it was; `shareWith/{principalId}` set to null drops the beneficiary
 * outright (`api/acl.rs:142-144`).
 */
export type SharePatch = Record<string, boolean | null>;

/** One path per named right, each granted. */
export function buildGrantPatch(principalId: Id, rights: readonly string[]): SharePatch {
  return Object.fromEntries(rights.map((right) => [`shareWith/${principalId}/${right}`, true]));
}

/**
 * One path per named right, each withdrawn — or the beneficiary itself.
 *
 * No named right is not an empty revocation: it is the whole entry going. That
 * is the difference between taking one permission back and closing the door, and
 * the confirmation sentence has to say which of the two is happening.
 */
export function buildRevokePatch(
  principalId: Id,
  rights: readonly string[] | undefined,
): SharePatch {
  if (rights === undefined || rights.length === 0) {
    return { [`shareWith/${principalId}`]: null };
  }

  return Object.fromEntries(rights.map((right) => [`shareWith/${principalId}/${right}`, false]));
}

/**
 * The patch one direction of the call produces.
 *
 * The two forms are picked here and nowhere else, so `precheck` and `run` cannot
 * disagree about what a call was going to write: one builds the patch to check
 * it, the other builds it to send it, and both go through this.
 */
export function buildSharePatch(
  action: "grant" | "revoke",
  principalId: Id,
  rights: readonly string[],
): SharePatch {
  return action === "grant"
    ? buildGrantPatch(principalId, rights)
    : buildRevokePatch(principalId, rights);
}

/**
 * The refusal a patch naming both a path and its own prefix earns, or nothing.
 *
 * RFC 8620 §5.3 makes such a patch invalid and the server answers `invalidPatch`.
 * The two builders above cannot produce one — the forms are mutually exclusive by
 * construction — so this guards the day a third form appears, and it guards it
 * before the request leaves rather than after the server has read it.
 */
export function refuseOverlappingPaths(patch: SharePatch): string | undefined {
  const keys = Object.keys(patch);
  const collision = keys.find((key) => keys.some((other) => other.startsWith(`${key}/`)));
  if (collision === undefined) return undefined;

  return (
    `Refused: this call would patch ${collision} and a path inside it in one go, which RFC 8620 ` +
    "§5.3 makes invalid. Take the whole beneficiary away, or name rights, never both at once."
  );
}

/**
 * The arguments of every object `/set` this module emits.
 *
 * An `update` and nothing else. Sharing brings no object into being and takes
 * none away: it writes one property of something that already exists, and neither
 * a creation nor a destruction has any business riding along under a confirmation
 * that spoke about access.
 *
 * The type's own non-cascade flag goes on every call all the same, false without
 * exception, including the calls that could not have destroyed anything anyway. A
 * server default is not a guarantee, and an argument left out is an argument no
 * test can see.
 */
export function shareSetArguments(
  type: ShareableType,
  accountId: Id,
  update: Record<Id, SharePatch>,
): Record<string, unknown> {
  switch (type) {
    case "Mailbox":
      return { accountId, update, onDestroyRemoveEmails: false };
    case "Calendar":
      return { accountId, update, onDestroyRemoveEvents: false };
    case "AddressBook":
      return { accountId, update, onDestroyRemoveContents: false };
    case "FileNode":
      // Delegated rather than restated: `files/edit.ts` owns `onExists` and the
      // child cascade for every `FileNode/set` this server sends, and a second
      // hand-written copy of the two would drift from it at the first correction.
      return { ...fileNodeSetArguments(accountId), update };
  }
}

/**
 * What the server made of each id, one line each.
 *
 * Two refusals are worth expecting by name, and both arrive as the server's own
 * words rather than as a mapping this module invents. `forbidden` is an account
 * that may read a share and not change it, which is a fact about the object.
 * `invalidProperties` is a beneficiary the directory does not hold, or a right
 * the type does not know, which is a fact about the call. Nothing is translated:
 * the description the server sends says which of the two it meant.
 */
export function describeShareOutcome(
  response: SetResponse<unknown>,
  ids: readonly Id[],
  noun: string,
  done: string,
  half: "updated" | "destroyed" = "updated",
): string {
  const refused = (half === "updated" ? response.notUpdated : response.notDestroyed) ?? {};

  const rows = ids.map((id) => {
    const error = refused[id];
    return { id, outcome: error === undefined ? done : `refused: ${describeSetError(error)}` };
  });

  // Counted off the server's answer, never off the rendered cell: a `done`
  // wording that happened to read like a refusal would move the headline.
  const failed = ids.filter((id) => refused[id] !== undefined).length;
  const succeeded = rows.length - failed;

  // "(s)" rather than a plural rule: one of the four nouns is "file or folder",
  // which no suffix pluralises into anything a reader would accept.
  const headline =
    failed === 0
      ? `${succeeded} ${noun}(s) ${done}.`
      : succeeded === 0
        ? `No ${noun} was ${done}: the server refused all ${rows.length}.`
        : `${succeeded} of ${rows.length} ${noun}(s) ${done}, ${failed} refused by the server.`;

  return `${headline}\n\n${renderTable(rows, ["id", "outcome"])}`;
}
