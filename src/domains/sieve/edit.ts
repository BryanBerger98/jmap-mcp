/**
 * What writing a Sieve script takes, shared by the tools that do it.
 *
 * Two functions build `SieveScript/set` arguments here, and nothing else in the
 * module builds any. Storing a script and activating one are two gestures, not
 * one: `sieveScriptSetArguments` cannot reach either activation argument because
 * the type it accepts leaves them out, and `sieveActivationArguments` cannot
 * reach a create, an update or a destroy because it takes none. Every call
 * changes one thing.
 *
 * Nothing here reads the network. The rule that keeps a store from rerouting the
 * mail flow should not need a server to be checked.
 */

import type { Id, SetError, SetResponse } from "../../jmap/types/core.js";
import type {
  SieveScriptCreation,
  SieveScriptPatch,
  SieveScriptSetArguments,
} from "../../jmap/types/sieve.js";
import type { BatchSubject } from "../../shared/batch.js";
import { renderTable } from "../../shared/render.js";

/** The key a creation is filed under: JMAP hands back the real id in `created`. */
export const CREATION_KEY = "new";

/** What an id names here, and the tool that hands those ids out. */
export const SIEVE_SCRIPTS: BatchSubject = {
  noun: "Sieve script",
  discoveredBy: "sieve_scripts",
};

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
 * Which way an activation goes, with no third state and no absent one.
 *
 * A boolean would have been enough to encode it and would have read as
 * `sieveActivationArguments(accountId, true)` at the call site, where the two
 * gestures that reroute every future message differ by one token.
 */
export type Activation = { activate: Id } | { deactivate: true };

/**
 * The second door onto `SieveScript/set`, and the only one that touches what
 * filters incoming mail.
 *
 * It is a separate function from `sieveScriptSetArguments` rather than an option
 * on it, because the split is what makes the storing path provably harmless: the
 * arguments it can build carry no `create`, no `update` and no `destroy`, so an
 * activation is never smuggled alongside a write and a write is never smuggled
 * alongside an activation. Each call changes one thing, and the confirmation the
 * caller answered named that thing.
 *
 * Both arguments are written on every call here too, one of them null.
 */
export function sieveActivationArguments(
  accountId: Id,
  activation: Activation,
): SieveScriptSetArguments {
  return {
    accountId,
    onSuccessActivateScript: "activate" in activation ? activation.activate : null,
    onSuccessDeactivateScript: "deactivate" in activation ? true : null,
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

/**
 * What a destruction came to, id by id.
 *
 * An id the server did not file a refusal against counts as destroyed: it names
 * what it refused, and reading success off `destroyed` instead would report a
 * script as still there on a server that answers with the ids in another shape.
 */
export function describeDestroyOutcome(
  response: SetResponse<unknown>,
  ids: readonly Id[],
  named: (id: Id) => string,
): string {
  const refused = response.notDestroyed ?? {};

  const rows = ids.map((id) => ({
    script: named(id),
    id,
    outcome: refused[id] === undefined ? "destroyed" : `refused: ${explainSetError(refused[id])}`,
  }));

  const failed = ids.filter((id) => refused[id] !== undefined).length;
  const succeeded = rows.length - failed;

  const headline =
    failed === 0
      ? `${succeeded} Sieve script${succeeded === 1 ? "" : "s"} destroyed.`
      : succeeded === 0
        ? `No Sieve script was destroyed: the server refused all ${rows.length}.`
        : `${succeeded} of ${rows.length} Sieve scripts destroyed, ${failed} refused by the server.`;

  return `${headline}\n\n${renderTable(rows, ["script", "id", "outcome"])}`;
}

/** The id of the script already holding the name, when the server names it. */
function existingId(error: SetError): string {
  const existing = (error as { existingId?: unknown }).existingId;
  return typeof existing === "string" ? `, under the id ${existing}` : "";
}
