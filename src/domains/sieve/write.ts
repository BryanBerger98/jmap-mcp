import { z } from "zod";
import type { SetError, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_SIEVE } from "../../jmap/types/core.js";
import type {
  SieveScript,
  SieveScriptValidateArguments,
  SieveScriptValidateResponse,
} from "../../jmap/types/sieve.js";
import { defineTool, type ToolContext, type ToolResult } from "../../registry/define-tool.js";
import { renderFields } from "../../shared/render.js";
import {
  buildScriptCreation,
  buildScriptPatch,
  CREATION_KEY,
  explainSetError,
  sieveScriptSetArguments,
} from "./edit.js";
import {
  activeScript,
  describeScripts,
  isVacationName,
  isVacationScript,
  SIEVE_MIME,
  scriptById,
} from "./script.js";

/**
 * Storing a Sieve script: upload the text, compile it, then write the object.
 *
 * The order is what makes this the one write in the module that changes nothing
 * about the mail flow. `SieveScript/validate` runs the very compiler `set` runs
 * (`sieve/validate.rs:37`), so a verdict here is a verdict for the write that
 * follows, and a script that does not compile never reaches storage.
 *
 * The one exception is written into `confirmWhen`: overwriting the body of the
 * script that is currently active changes what filters incoming mail the moment
 * the write lands, though the call is still a `draft`. The class keeps telling
 * the truth about what the call does; the question is asked anyway.
 */

const inputSchema = z
  .strictObject({
    action: z.enum(["store"]).describe("What to do: store a Sieve script, without activating it."),
    name: z
      .string()
      .min(1)
      .describe(
        "The name of the script. Always required, including on a correction: a script stored " +
          "without one is given a random name by the server. The name `vacation` is reserved.",
      ),
    script: z
      .string()
      .min(1)
      .describe("The Sieve source, as text. It is compiled before anything is stored."),
    id: z
      .string()
      .optional()
      .describe(
        "The script to correct, as sieve_scripts returns it. Left out, a new script is created.",
      ),
  })
  .describe("Store a Sieve script. Activating one is a separate action.");

type Input = z.infer<typeof inputSchema>;

export const sieveWrite = defineTool({
  name: "sieve_write",
  title: "Store a Sieve script",
  description:
    "Stores a Sieve script on the account: creates one, or replaces the text of one that is " +
    "already there. " +
    "Nothing stored here filters anything: only the active script runs, and this tool never " +
    "activates. " +
    "The text is compiled before it is written, so a script that does not compile is refused with " +
    "the compiler's own message and nothing is stored. " +
    "The script named `vacation` belongs to the vacation response and is written through " +
    "vacation_manage, never here.",
  inputSchema,
  // Storing loses nothing and sends nothing: the account keeps filtering with
  // whatever it was filtering with before the call.
  classes: ["draft"],
  classify: () => "draft",
  summarize: async (input, context) => {
    if (input.id === undefined) return `Store a new Sieve script named ${input.name}.`;

    const target = await scriptById(input.id, context);
    const named = target === undefined ? input.id : describeScripts([target]);
    return `Replace the text of ${named} and name it ${input.name}.`;
  },
  precheck: async (input, context) => {
    // Refused here rather than left to the server, which does refuse both
    // (`sieve/set.rs:416-424` and `:443-448`) but at the cost of a round trip
    // that uploads the text first.
    if (isVacationName(input.name)) {
      return (
        "Refused: `vacation` is the name the vacation response owns, and a script stored under it " +
        "would be overwritten the next time that response is set. Use vacation_manage to change " +
        "the automatic reply, or store this script under another name."
      );
    }

    if (input.id === undefined) return undefined;

    const target = await scriptById(input.id, context);
    if (target === undefined) {
      return (
        `Refused: no Sieve script has the id ${input.id}. Run sieve_scripts with action list to ` +
        "see what the account holds, or leave `id` out to store a new script."
      );
    }

    return isVacationScript(target)
      ? `Refused: ${describeScripts([target])} is the script the vacation response generates, and ` +
          "rewriting it by hand is refused by the server. Change the automatic reply with " +
          "vacation_manage instead."
      : undefined;
  },
  /**
   * The one call this tool makes that is not without consequence.
   *
   * A `draft` class is the honest one — nothing is destroyed and nothing is sent
   * — but replacing the body of the active script reroutes the very next message
   * the account receives. The reason is returned in place of the class, because
   * "this is a draft operation" says nothing about that.
   */
  confirmWhen: async (input, context) => {
    if (input.id === undefined) return undefined;

    const active = await activeScript(context);
    if (active === undefined || active.id !== input.id) return undefined;

    return (
      `${describeScripts([active])} is the script currently filtering incoming mail. Replacing ` +
      "its text changes how the next message is handled, as soon as this call lands."
    );
  },
  run: async (input, context) => runStore(input, context),
});

/**
 * Upload, compile, write — in that order, and the order carries the guarantee.
 *
 * The compilation is not a courtesy check before a call that would fail anyway:
 * a `SieveScript/set` refused for a syntax error still consumed a blob, and its
 * answer would carry `invalidScript` with the same message a round trip later.
 * Running the compiler first is what lets the refusal be the whole answer.
 */
async function runStore(input: Input, context: ToolContext): Promise<ToolResult> {
  const { accountId } = context.session;

  // The text travels through the conversation, unlike the bytes of the file
  // storage: it is what the caller wrote and what they will read back.
  const blob = await context.blobs.upload(new TextEncoder().encode(input.script), SIEVE_MIME);

  const validateArguments: SieveScriptValidateArguments = { accountId, blobId: blob.blobId };
  const verdict = await context.client.request<SieveScriptValidateResponse>(
    [CAPABILITY_CORE, CAPABILITY_SIEVE],
    ["SieveScript/validate", validateArguments, "0"],
  );

  if (verdict.error !== null) {
    // `error` is required by the response type, so an absent one is a server
    // that answered something else entirely. Storing on the strength of a
    // verdict nobody gave is the one thing this ordering exists to prevent.
    return {
      text:
        verdict.error === undefined
          ? "Refused: the server returned no verdict on the script, so nothing was stored. " +
            "Nothing here can tell whether the text compiles."
          : explainValidation(verdict.error),
    };
  }

  const response = await context.client.request<SetResponse<SieveScript>>(
    [CAPABILITY_CORE, CAPABILITY_SIEVE],
    [
      "SieveScript/set",
      sieveScriptSetArguments(
        accountId,
        input.id === undefined
          ? { create: { [CREATION_KEY]: buildScriptCreation(input.name, blob.blobId) } }
          : { update: { [input.id]: buildScriptPatch({ name: input.name, blobId: blob.blobId }) } },
      ),
      "0",
    ],
  );

  return {
    text:
      input.id === undefined ? describeCreated(response, input) : describeUpdated(response, input),
  };
}

/**
 * The compiler's verdict, with the two failures it can hand back kept apart.
 *
 * `blobNotFound` says the upload did not survive to the compilation; every other
 * code says the script itself is wrong. Reporting the first as a syntax error
 * would send the caller hunting through source that compiles.
 */
function explainValidation(error: SetError): string {
  if (error.type === "blobNotFound") {
    return (
      "Refused: the uploaded text was gone by the time the server tried to compile it, so nothing " +
      "was stored. The script itself was never judged; try the call again."
    );
  }

  // The compiler's own message, on its own lines: it names the construct and
  // usually the line, which is the whole of what the caller needs to fix it.
  const said = error.description ?? `nothing beyond the code ${error.type}.`;
  return `Refused: the script does not compile, so nothing was stored. The server's compiler said:\n\n${said}`;
}

/** What a creation came to, read off `created` and nothing else. */
function describeCreated(response: SetResponse<SieveScript>, input: Input): string {
  const created = response.created?.[CREATION_KEY];

  if (created === undefined) {
    const refused = response.notCreated?.[CREATION_KEY];
    return refused === undefined
      ? `Script ${input.name} was not created: the server said nothing, neither creating it nor refusing it.`
      : explainSetError(refused);
  }

  return renderFields({
    stored: `Script ${input.name} created`,
    id: created.id,
    active: NOT_ACTIVATED,
  });
}

/** What a correction came to. `updated` may carry null, which is still a success. */
function describeUpdated(response: SetResponse<SieveScript>, input: Input): string {
  const id = input.id ?? "";

  if (response.updated !== undefined && id in response.updated) {
    return renderFields({
      stored: `Script ${input.name} replaced`,
      id,
      active: NOT_ACTIVATED,
    });
  }

  const refused = response.notUpdated?.[id];
  return refused === undefined
    ? `Script ${id} was not replaced: the server said nothing, neither updating it nor refusing it.`
    : explainSetError(refused);
}

/**
 * Said on every success, and said in full.
 *
 * A script stored and not activated does nothing at all, and the difference is
 * invisible from the answer unless the answer names it: "stored" reads like
 * "in effect" to anybody who has not read the RFC.
 */
const NOT_ACTIVATED =
  "no — storing does not activate. Only one script filters at a time, and this call left that " +
  "unchanged.";
