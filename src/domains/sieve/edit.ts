/**
 * What writing a Sieve script takes, shared by the tools that do it.
 *
 * The whole module funnels through `sieveScriptSetArguments`, which is the only
 * place `SieveScript/set` arguments are built. Storing a script and activating
 * one are two gestures here, not one: the storing path cannot reach either
 * activation argument, because the type it accepts leaves them out. Phase 3
 * opens the second door explicitly, through `activationArguments`.
 *
 * Nothing here reads the network. The rule that keeps a store from rerouting the
 * mail flow should not need a server to be checked.
 */

import type { Id, SetError } from "../../jmap/types/core.js";
import type {
  SieveScriptCreation,
  SieveScriptPatch,
  SieveScriptSetArguments,
} from "../../jmap/types/sieve.js";

/** The key a creation is filed under: JMAP hands back the real id in `created`. */
export const CREATION_KEY = "new";

/**
 * Everything a `SieveScript/set` may carry beyond the account, minus the two
 * activation arguments.
 *
 * They are subtracted at the type level rather than checked at runtime: a caller
 * on the storing path cannot name them, so a store that activated a script would
 * fail to compile rather than fail a test.
 */
export type SieveWrite = Partial<
  Omit<
    SieveScriptSetArguments,
    "accountId" | "onSuccessActivateScript" | "onSuccessDeactivateScript"
  >
>;

/**
 * The object a creation sends.
 *
 * `name` is required by the type and never inferred: without it,
 * `sieve/set.rs:507-513` assigns a random fifteen-character name, and a script
 * nobody can find again is a script nobody can delete either.
 *
 * `isActive` is not omitted here so much as unrepresentable — see the third
 * activation path in `types/sieve.ts`.
 */
export function buildScriptCreation(name: string, blobId: Id): SieveScriptCreation {
  return { name, blobId };
}

/**
 * The patch an existing script receives: only the properties the call named.
 *
 * Both keys are top level and neither is a prefix of the other, so there is no
 * RFC 8620 §5.3 collision to guard against. A patch carrying nothing is
 * representable and is the caller's problem to refuse, not this builder's: it
 * would be a call asking for no change at all.
 */
export function buildScriptPatch(edit: { name?: string; blobId?: Id }): SieveScriptPatch {
  const patch: SieveScriptPatch = {};

  if (edit.name !== undefined) patch.name = edit.name;
  if (edit.blobId !== undefined) patch.blobId = edit.blobId;

  return patch;
}

/**
 * The arguments of a `SieveScript/set` that changes what is stored, never what
 * is active.
 *
 * Both activation arguments are written explicitly to `null`, on every call,
 * including the ones with nothing to activate. A server default is not a
 * guarantee, and an argument left out is an argument no test can see — the same
 * reasoning that writes the three cascade flags in the other domains.
 */
export function sieveScriptSetArguments(
  accountId: Id,
  write: SieveWrite = {},
): SieveScriptSetArguments {
  return {
    accountId,
    ...write,
    // Last, so no caller can pass them: this path stores, and storing is not
    // activating.
    onSuccessActivateScript: null,
    onSuccessDeactivateScript: null,
  };
}

/**
 * A `SetError` turned into something the caller can act on.
 *
 * The codes translated are the ones Stalwart puts on the wire, not the ones
 * RFC 9661 names: `invalidScript` and not `invalidSieve`, `scriptIsActive` and
 * not `sieveIsActive`. A translation written on the RFC spellings would compile,
 * read correctly, and never match a single answer.
 */
export function explainSetError(error: SetError): string {
  const said = error.description === undefined ? "" : ` The server said: ${error.description}`;

  switch (error.type) {
    case "alreadyExists":
      return (
        "Refused by the server: a script of that name is already there" +
        `${existingId(error)}. Store under another name, or pass that id to correct the script ` +
        `that holds it.${said}`
      );
    case "invalidScript":
      // The compiler's own message, and the only refusal worth reading in full:
      // it names the construct and often the line.
      return `Refused by the server: the script does not compile.${said}`;
    case "scriptIsActive":
      return (
        "Refused by the server: that script is the one filtering incoming mail, and this server " +
        "never removes the active script out from under the account. Activate another script " +
        `first, then delete this one.${said}`
      );
    case "invalidProperties":
      return (
        "Refused by the server: one of the properties written is not acceptable, most often a " +
        `name longer than the server accepts.${said}`
      );
    case "overQuota":
      return (
        "Refused by the server: the account has no room left for this script. Delete a script " +
        `with sieve_write, or ask for more quota.${said}`
      );
    case "blobNotFound":
      return (
        "Refused by the server: the uploaded text was not found when the script was written. " +
        `Nothing was stored; the upload has to be redone.${said}`
      );
    default:
      return `Refused by the server: ${error.type}.${said}`;
  }
}

/** The id of the script already holding the name, when the server names it. */
function existingId(error: SetError): string {
  const existing = (error as { existingId?: unknown }).existingId;
  return typeof existing === "string" ? `, under the id ${existing}` : "";
}
