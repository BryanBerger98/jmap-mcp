/**
 * Sieve scripts to compact text, and the one read every tool of the module
 * shares.
 *
 * Reading, storing, activating and destroying all need the same three things:
 * the name behind an id, whether that id is the active script, and whether it is
 * the one the vacation response owns. Asked once per handler invocation and
 * cached, so `precheck`, `confirmWhen`, `summarize` and `run` decide on the same
 * answer instead of on four round trips that could disagree.
 *
 * One function reads the network, `allScripts`; one moves bytes, `scriptText`.
 * Everything else is pure and testable without a server.
 */

import type { GetResponse, Id } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_SIEVE } from "../../jmap/types/core.js";
import type { SieveScript, SieveScriptGetArguments } from "../../jmap/types/sieve.js";
import { VACATION_SCRIPT_NAME } from "../../jmap/types/sieve.js";
import type { ToolContext } from "../../registry/define-tool.js";

/**
 * What a `SieveScript/get` is asked for.
 *
 * All four of them, because there are only four (`sieve/get.rs:40-44`) and every
 * one carries a decision: the name is what a person recognises, `isActive` is
 * what makes a destruction refusable, and `blobId` is where the text lives.
 */
export const SCRIPT_PROPERTIES = ["id", "name", "blobId", "isActive"] as const;

/** The columns of a script table, in reading order. */
export const SCRIPT_COLUMNS = ["active", "name", "id", "note"];

/** The MIME type the blob channel is told to call a script, in both directions. */
export const SIEVE_MIME = "application/sieve";

/**
 * How many characters of a script body one answer prints.
 *
 * A Sieve script is prose a person wrote, so the ceiling is generous; past it
 * the answer says how many bytes it left out rather than trailing off.
 */
export const MAX_SCRIPT_CHARS = 12000;

/** How many scripts a refusal or a summary names before it counts the rest. */
const SCRIPTS_NAMED = 3;

/** The one test for the vacation response's own script, so no tool spells it. */
export function isVacationScript(script: SieveScript): boolean {
  return isVacationName(script.name);
}

/** The same test on a bare name, for a creation that has no script yet. */
export function isVacationName(name: string | undefined): boolean {
  return name?.trim().toLowerCase() === VACATION_SCRIPT_NAME;
}

/** One row of a script table. The vacation script is pointed at its own tool. */
export function renderScriptRow(script: SieveScript): Record<string, unknown> {
  return {
    active: script.isActive === true ? "active" : "",
    name: script.name ?? "",
    id: script.id,
    note: isVacationScript(script)
      ? "vacation response — read and set it with vacation_manage"
      : "",
  };
}

/**
 * "newsletters (sc-1)" — one script, in the terms a sentence can carry.
 *
 * Almost every refusal and every summary of this module is about a single
 * script, and a count in front of it ("1 script: newsletters (sc-1) carries no
 * blobId") reads as a broken sentence. The set renderer below builds on this one
 * rather than repeating it, so the two can never name the same script two ways.
 */
export function describeScript(script: SieveScript): string {
  return `${script.name ?? "(unnamed)"} (${script.id})`;
}

/**
 * "3 scripts: newsletters (sc-1), archive (sc-3) and 1 more".
 *
 * A count alone is not something anyone can arbitrate: confirming the erasure of
 * "3 scripts" is confirming a number.
 */
export function describeScripts(scripts: readonly SieveScript[], total = scripts.length): string {
  const count = `${total} script${total === 1 ? "" : "s"}`;
  if (scripts.length === 0) return count;

  const named = scripts.slice(0, SCRIPTS_NAMED).map(describeScript);
  const rest = total - named.length;

  return `${count}: ${named.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}

/**
 * Every script the account holds, read once per handler invocation.
 *
 * `ids: null` rather than a query: an account holds a handful of scripts, the
 * answer is four short properties each, and one read serves every question the
 * module asks — which id is active, which id is the vacation script, what a
 * given id is called. Three targeted reads would cost three round trips to learn
 * the same thing, and could disagree between the confirmation and the write.
 */
export async function allScripts(context: ToolContext): Promise<SieveScript[]> {
  const args: SieveScriptGetArguments = {
    accountId: context.session.accountId,
    ids: null,
    properties: [...SCRIPT_PROPERTIES],
  };

  const response = await context.once("sieve:scripts", () =>
    context.client.request<GetResponse<SieveScript>>(
      [CAPABILITY_CORE, CAPABILITY_SIEVE],
      ["SieveScript/get", args, "0"],
    ),
  );

  return response.list;
}

/** The one script the account is currently filtering with, if any. */
export async function activeScript(context: ToolContext): Promise<SieveScript | undefined> {
  return (await allScripts(context)).find((script) => script.isActive === true);
}

/** One script by id, off the shared read. Undefined when the account has no such id. */
export async function scriptById(id: Id, context: ToolContext): Promise<SieveScript | undefined> {
  return (await allScripts(context)).find((script) => script.id === id);
}

/**
 * The text of a script, through the blob channel.
 *
 * The section of the `blobId` the server hands back is already bounded to the
 * source (`sieve/get.rs:117-121`), so nothing here has to strip the compiled
 * archive stored beside it.
 */
export async function scriptText(script: SieveScript, context: ToolContext): Promise<string> {
  const { blobId } = script;
  if (blobId === undefined) {
    throw new Error(`Script ${script.id} carries no blobId, so it has no text to download.`);
  }

  const bytes = await context.blobs.download(blobId, script.name ?? script.id, SIEVE_MIME);
  return new TextDecoder().decode(bytes);
}

/**
 * A script body cut to the rendering ceiling, saying what it left out.
 *
 * The count is in bytes and measured on the part that was dropped, not guessed
 * from a character count: a script full of accented comments would otherwise be
 * reported as shorter than it is.
 */
export function renderScriptText(text: string, max = MAX_SCRIPT_CHARS): string {
  if (text.length <= max) return text;

  const omitted = new TextEncoder().encode(text.slice(max)).byteLength;
  return `${text.slice(0, max)}\n\n[cut here: ${omitted} more bytes of this script are not shown]`;
}
