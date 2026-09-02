/**
 * RFC 9661 — JMAP for Sieve scripts, plus RFC 8621 §8 — the vacation response.
 *
 * Three rules are load-bearing here, and each is enforced by what this file
 * refuses to make representable rather than by a check somewhere else:
 *
 * - **Three paths activate a script, not two.** `onSuccessActivateScript` and
 *   `onSuccessDeactivateScript` are the two anybody expects. The third is the
 *   `isActive` property itself: written into a creation or an update, Stalwart
 *   captures it (`sieve/set.rs:482-484`), pushes it into the pending
 *   activations, and translates it back into one of the two arguments
 *   (`sieve/set.rs:358-368`). A tool emitting it would activate a script while
 *   believing it merely named one, so neither a creation nor a patch can carry
 *   it here.
 * - **The conditions and the comparators are closed lists.** `SieveScript/query`
 *   honours `name` and `isActive` and sorts on the same two. Unlike the file
 *   storage, Stalwart raises a real `UnsupportedFilter` or `UnsupportedSort`
 *   past them, so the closure is here to keep a call from being written at all.
 * - **The script text is not in the object.** `SieveScript/get` hands back four
 *   properties and no more (`sieve/get.rs:40-44`); the body travels as a blob,
 *   like a file. The section of the returned `BlobId` is bounded to `sieve.size`
 *   (`sieve/get.rs:117-121`), so a download yields the source alone, without the
 *   compiled archive the server stores beside it.
 *
 * One rule has no type to hold it, and is written here for want of a better
 * place: the name `vacation` is reserved. Updating a script that carries it is
 * refused (`sieve/set.rs:416-424`) and so is creating one under it
 * (`sieve/set.rs:443-448`) — but destroying it is guarded by nothing
 * (`sieve/set.rs:329-351` only tests the active-script condition), which makes
 * the client the sole guard on that one path.
 */

import type { Id, SetError } from "./core.js";

/**
 * The name Stalwart reserves for the script the vacation response generates.
 *
 * Compared case-insensitively everywhere it is used: over-refusing a script
 * called `Vacation` costs a rename, under-refusing costs the vacation response.
 */
export const VACATION_SCRIPT_NAME = "vacation";

/** The only id `VacationResponse` ever carries: the object is a singleton. */
export const VACATION_SINGLETON_ID = "singleton";

/**
 * A Sieve script, with the four properties the server returns.
 *
 * Every one is optional because `properties` narrows the answer, and `id` alone
 * is guaranteed. The text is absent by design: `blobId` points at it.
 */
export interface SieveScript {
  id: Id;
  name?: string;
  blobId?: Id;
  isActive?: boolean;
}

/**
 * The two conditions `SieveScript/query` executes.
 *
 * `name` matches a substring, `isActive` selects the one active script. A third
 * condition is not silently dropped here as it would be on file nodes: the
 * server answers `UnsupportedFilter`.
 */
export interface SieveScriptFilterCondition {
  name?: string;
  isActive?: boolean;
}

/** The two sortable properties. Nothing else is representable. */
export type SieveScriptComparatorProperty = "name" | "isActive";

export interface SieveScriptComparator {
  property: SieveScriptComparatorProperty;
  isAscending: boolean;
}

export type SieveScriptGetArguments = {
  accountId: Id;
  ids?: Id[] | null;
  properties?: string[] | null;
};

export type SieveScriptQueryArguments = {
  accountId: Id;
  filter?: SieveScriptFilterCondition;
  sort?: SieveScriptComparator[];
  position?: number;
  limit?: number;
  calculateTotal?: boolean;
};

/**
 * A script being created: a name and the blob holding its text.
 *
 * `isActive` is declared as `never` rather than left out: omitting it would let
 * an excess-property check pass on anything typed loosely upstream, while this
 * makes a literal carrying it fail to compile. See the third activation path in
 * the header.
 */
export type SieveScriptCreation = {
  name: string;
  blobId: Id;
  isActive?: never;
};

/**
 * A patch on an existing script, `isActive` made unrepresentable for the same
 * reason as on a creation.
 *
 * Not a `Record<string, unknown>` like the other domains use for patches: the
 * object has two writable properties and no nesting, so naming them costs
 * nothing and closes the third activation path at the type level.
 */
export type SieveScriptPatch = {
  name?: string;
  blobId?: Id;
  isActive?: never;
};

export type SieveScriptSetArguments = {
  accountId: Id;
  create?: Record<Id, SieveScriptCreation>;
  update?: Record<Id, SieveScriptPatch>;
  destroy?: Id[];
  /** The id to activate, or null to leave the active script alone. */
  onSuccessActivateScript?: Id | null;
  /** True to leave the account with no active script at all. */
  onSuccessDeactivateScript?: boolean | null;
};

/**
 * Compiles an already-uploaded blob without storing it.
 *
 * The same compiler `SieveScript/set` runs (`sieve/validate.rs:37`), so a script
 * that passes here is a script the server will accept.
 */
export type SieveScriptValidateArguments = {
  accountId: Id;
  blobId: Id;
};

/**
 * `error` is null when the script compiles, and carries the compiler's own
 * message when it does not.
 *
 * The wire codes are not the RFC's: Stalwart serialises `invalidScript` where
 * RFC 9661 names `invalidSieve`, and `scriptIsActive` where it names
 * `sieveIsActive`. A translation written on the RFC spellings would never match.
 */
export interface SieveScriptValidateResponse {
  accountId: Id;
  error: SetError | null;
}

/**
 * The vacation response, a singleton object per account.
 *
 * Its active state is not its own: it is the active state of the `vacation`
 * script (`vacation/set.rs:144`), which is why turning it on deactivates
 * whatever script was filtering (`vacation/set.rs:281-283`).
 */
export interface VacationResponse {
  id: Id;
  isEnabled?: boolean;
  fromDate?: string | null;
  toDate?: string | null;
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
}

/**
 * What one call changes, and nothing more.
 *
 * A key absent leaves the property as it stands; a key set to null clears it
 * (`vacation/set.rs:214-218`). `isEnabled` is the one that matters: the server
 * preserves it across a change of text, so writing it unasked would fuse two
 * gestures the tools keep apart.
 */
export type VacationPatch = {
  isEnabled?: boolean;
  fromDate?: string | null;
  toDate?: string | null;
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
};

export type VacationResponseGetArguments = {
  accountId: Id;
  ids?: Id[] | null;
  properties?: string[] | null;
};

/**
 * Only an update is representable.
 *
 * The server refuses a creation and a destruction on a singleton, and a type
 * that could express either would leave the refusal to a round trip.
 */
export type VacationResponseSetArguments = {
  accountId: Id;
  update?: Record<Id, VacationPatch>;
  create?: never;
  destroy?: never;
};
