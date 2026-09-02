import { z } from "zod";
import type { Id, SetError, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_SIEVE } from "../../jmap/types/core.js";
import type {
  SieveScript,
  SieveScriptValidateArguments,
  SieveScriptValidateResponse,
} from "../../jmap/types/sieve.js";
import { defineTool, type ToolContext, type ToolResult } from "../../registry/define-tool.js";
import { refuseOversizedBatch } from "../../shared/batch.js";
import { renderFields } from "../../shared/render.js";
import {
  buildScriptCreation,
  buildScriptPatch,
  CREATION_KEY,
  describeDestroyOutcome,
  explainSetError,
  SIEVE_SCRIPTS,
  sieveActivationArguments,
  sieveScriptSetArguments,
} from "./edit.js";
import { describeRadius, wideRadiusActions } from "./radius.js";
import {
  activeScript,
  allScripts,
  describeScript,
  describeScripts,
  isVacationName,
  isVacationScript,
  SIEVE_MIME,
  scriptById,
  scriptText,
} from "./script.js";

/**
 * Writing Sieve scripts: storing one, switching which one runs, destroying them.
 *
 * Four actions, and they do not weigh the same. `store` changes what the account
 * holds and nothing about what it does, which is why it is a `draft`. The other
 * three change what happens to every message that arrives afterwards, and all
 * three are classified `destroy`: activating a script that carries a `discard`
 * loses mail with no copy anywhere, deactivating one stops filtering that may be
 * the only thing keeping the inbox usable, and a destroyed script does not come
 * back — Sieve has no trash.
 *
 * The two writes stay apart all the way down: `sieveScriptSetArguments` builds
 * what stores, `sieveActivationArguments` builds what activates, and neither can
 * express the other's arguments. A confirmation the caller answered names one
 * gesture, and one gesture is what the request carries.
 */

const inputSchema = z
  .strictObject({
    action: z
      .enum(["store", "activate", "deactivate", "delete"])
      .describe(
        "What to do: store a script without running it, make one the active script, switch " +
          "filtering off entirely, or destroy scripts for good.",
      ),
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The name of the script. Required on store, including on a correction: a script stored " +
          "without one is given a random name by the server. The name `vacation` is reserved.",
      ),
    script: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The Sieve source, as text. Required on store, and compiled before anything is stored.",
      ),
    id: z
      .string()
      .optional()
      .describe(
        "One script, as sieve_scripts returns it. Required on activate. On store, it names the " +
          "script to correct; left out there, a new script is created.",
      ),
    ids: z
      .array(z.string())
      .optional()
      .describe(
        "The scripts to destroy, exactly as sieve_scripts returned them. Required on delete.",
      ),
  })
  .refine((input) => input.action !== "store" || input.name !== undefined, {
    message: "Give the script a `name`.",
    path: ["name"],
  })
  .refine((input) => input.action !== "store" || input.script !== undefined, {
    message: "Give the Sieve source to store in `script`.",
    path: ["script"],
  })
  .refine((input) => input.action !== "activate" || input.id !== undefined, {
    message: "Name the script to activate with `id`.",
    path: ["id"],
  })
  .refine((input) => input.action !== "delete" || input.ids !== undefined, {
    message: "Name the scripts to destroy with `ids`.",
    path: ["ids"],
  })
  .describe("Store, activate, deactivate or destroy Sieve scripts.");

type Input = z.infer<typeof inputSchema>;

export const sieveWrite = defineTool({
  name: "sieve_write",
  title: "Store, activate or destroy Sieve scripts",
  description:
    "Writes the Sieve filters of the account. " +
    "`store` creates a script or replaces the text of one, and activates nothing: the text is " +
    "compiled first, so a script that does not compile is refused with the compiler's own message " +
    "and nothing is stored. " +
    "`activate` makes one script the one that filters incoming mail, which always stops whatever " +
    "was filtering before — only one script runs at a time. " +
    "`deactivate` leaves the account with no filtering at all. " +
    "`delete` destroys scripts for good: Sieve has no trash and no later call brings one back. " +
    "It acts on ids only, as sieve_scripts returns them. " +
    "The script named `vacation` belongs to the vacation response: it is written and activated " +
    "through vacation_manage, never here. `deactivate` does reach it, because it switches off " +
    "whatever script is active: when that is the vacation response, the automatic reply stops " +
    "answering.",
  inputSchema,
  // `store` leaves the mail flow exactly as it was. The other three decide what
  // happens to every message that arrives afterwards, and one of them is
  // irreversible in the plain sense.
  classes: ["draft", "destroy"],
  classify: (input) => (input.action === "store" ? "draft" : "destroy"),
  summarize: async (input, context) => {
    switch (input.action) {
      case "activate":
        return summarizeActivate(input, context);
      case "deactivate":
        return summarizeDeactivate(context);
      case "delete":
        return summarizeDelete(input, context);
      default:
        return summarizeStore(input, context);
    }
  },
  precheck: async (input, context) => {
    switch (input.action) {
      case "activate":
        return precheckActivate(input, context);
      case "deactivate":
        return precheckDeactivate(context);
      case "delete":
        return precheckDelete(input, context);
      default:
        return precheckStore(input, context);
    }
  },
  /**
   * The one call this tool makes that is not without consequence, and is not
   * already being confirmed for its class.
   *
   * `draft` is the honest class for a store — nothing is destroyed and nothing
   * is sent — but replacing the body of the active script reroutes the very next
   * message the account receives. The reason is returned in place of the class,
   * because "this is a draft operation" says nothing about that.
   */
  confirmWhen: async (input, context) => {
    if (input.action !== "store" || input.id === undefined) return undefined;

    const active = await activeScript(context);
    if (active === undefined || active.id !== input.id) return undefined;

    return (
      `${describeScript(active)} is the script currently filtering incoming mail. Replacing ` +
      "its text changes how the next message is handled, as soon as this call lands."
    );
  },
  run: async (input, context) => {
    switch (input.action) {
      case "activate":
        return runActivate(input, context);
      case "deactivate":
        return runDeactivate(context);
      case "delete":
        return runDelete(input, context);
      default:
        return runStore(input, context);
    }
  },
});

/* ------------------------------------------------------------------ store -- */

function summarizeStore(input: Input, context: ToolContext): Promise<string> | string {
  if (input.id === undefined) return `Store a new Sieve script named ${input.name}.`;

  const id = input.id;
  return scriptById(id, context).then((target) => {
    const named = target === undefined ? id : describeScript(target);
    return `Replace the text of ${named} and name it ${input.name}.`;
  });
}

async function precheckStore(input: Input, context: ToolContext): Promise<string | undefined> {
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
  if (target === undefined) return unknownId(input.id);

  return isVacationScript(target)
    ? `Refused: ${describeScript(target)} is the script the vacation response generates, and ` +
        "rewriting it by hand is refused by the server. Change the automatic reply with " +
        "vacation_manage instead."
    : undefined;
}

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
  const source = input.script ?? "";
  const name = input.name ?? "";

  // The text travels through the conversation, unlike the bytes of the file
  // storage: it is what the caller wrote and what they will read back.
  const blob = await context.blobs.upload(new TextEncoder().encode(source), SIEVE_MIME);

  const validateArguments: SieveScriptValidateArguments = { accountId, blobId: blob.blobId };
  const verdict = await context.client.request<SieveScriptValidateResponse>(
    [CAPABILITY_CORE, CAPABILITY_SIEVE],
    ["SieveScript/validate", validateArguments, "0"],
  );

  if (verdict.error !== null) {
    // `error` is required by the response type, so an absent one is a server
    // that answered something else entirely. Storing on the strength of a
    // verdict nobody gave is the one thing this ordering exists to prevent.
    const said =
      verdict.error === undefined
        ? "Refused: the server returned no verdict on the script, so nothing was stored. " +
          "Nothing here can tell whether the text compiles."
        : explainValidation(verdict.error);

    // The upload is the step above, so every refusal from here on leaves the
    // text on the server — except the one refusal that already says the upload
    // is gone. Appending the sentence to `blobNotFound` would contradict it word
    // for word.
    return { text: verdict.error?.type === "blobNotFound" ? said : withStrayText(said) };
  }

  const response = await context.client.request<SetResponse<SieveScript>>(
    [CAPABILITY_CORE, CAPABILITY_SIEVE],
    [
      "SieveScript/set",
      sieveScriptSetArguments(
        accountId,
        input.id === undefined
          ? { create: { [CREATION_KEY]: buildScriptCreation(name, blob.blobId) } }
          : { update: { [input.id]: buildScriptPatch({ name, blobId: blob.blobId }) } },
      ),
      "0",
    ],
  );

  const outcome =
    input.id === undefined ? describeCreated(response, name) : describeUpdated(response, input);

  // Said here and not in `explainSetError`, which also serves the destruction:
  // that path uploads nothing. The two steps cannot be reordered — a script
  // naming a blob that was never uploaded references nothing — so anything short
  // of a confirmed store leaves the text behind it. The condition is the store
  // and not the refusal: a server that names neither leaves the same stray text
  // as one that refuses.
  return { text: outcome.stored ? outcome.text : withStrayText(outcome.text) };
}

/**
 * The sentence every refusal after the upload carries.
 *
 * The text travelled before the server ever judged it, and no tool in this
 * module can take it back. Hearing it from the answer beats discovering it from
 * a quota.
 */
function withStrayText(text: string): string {
  return (
    `${text}\n\nThe script text was already uploaded before this answer: the server holds it ` +
    "unreferenced, and no tool here can remove it."
  );
}

/* --------------------------------------------------------------- activate -- */

/**
 * What activating this script commits the account to, in one paragraph.
 *
 * Three things, and the third is the one nobody asks about: the script's name,
 * what its source can do to a message, and what stops running the moment this
 * one starts. Only one script filters at a time (`sieve/set.rs:378-383`), so
 * every activation is also a deactivation, and a confirmation that named only
 * the incoming script would hide half of what it changes.
 */
async function summarizeActivate(input: Input, context: ToolContext): Promise<string> {
  const id = input.id ?? "";
  const target = await scriptById(id, context);
  const named = target === undefined ? id : describeScript(target);

  const source = target === undefined ? undefined : await scriptSource(target, context);
  const radius =
    source === undefined
      ? "Its source could not be read, so what it does to a message is unknown."
      : describeRadius(wideRadiusActions(source));

  return (
    `Make ${named} the script that filters incoming mail, from the next message on. ` +
    `${radius} ${describeReplaced(await activeScript(context), id)}`
  );
}

async function precheckActivate(input: Input, context: ToolContext): Promise<string | undefined> {
  const id = input.id ?? "";
  const target = await scriptById(id, context);

  // An unknown id is refused here because the server does not refuse it: it
  // drops `onSuccessActivateScript` silently (`sieve/set.rs:97-100`) and answers
  // a success that activated nothing.
  if (target === undefined) return unknownId(id);

  if (isVacationScript(target)) {
    return (
      `Refused: ${describeScript(target)} is the script the vacation response generates. ` +
      "Turning the automatic reply on is what activates it, and vacation_manage is where that " +
      "happens — activating it by hand here would leave the response on with nothing having " +
      "asked for it."
    );
  }

  const source = await scriptSource(target, context);
  if (source === undefined) {
    // The confirmation would have to say "this script does something, we could
    // not read what". Nobody can arbitrate that, so it is not put to them.
    return (
      `Refused: the source of ${describeScript(target)} could not be read, so this call cannot ` +
      "say what activating it would do to incoming mail. Nothing was activated; try " +
      "sieve_scripts with action show to see whether the text is reachable at all."
    );
  }

  return undefined;
}

async function runActivate(input: Input, context: ToolContext): Promise<ToolResult> {
  const id = input.id ?? "";
  // Read before the write, off the same cached answer `precheck` decided on:
  // afterwards the account has a different active script, and the report would
  // name the one it just installed as the one it replaced.
  const scripts = await allScripts(context);
  const target = scripts.find((script) => script.id === id);
  const previous = scripts.find((script) => script.isActive === true);

  await context.client.request<SetResponse<SieveScript>>(
    [CAPABILITY_CORE, CAPABILITY_SIEVE],
    ["SieveScript/set", sieveActivationArguments(context.session.accountId, { activate: id }), "0"],
  );

  // Two kinds of statement, kept apart because only one of them is established.
  // `asked` and `before` come off the read above; the activation itself comes
  // off an answer that carries no per-script result — `sieveActivationArguments`
  // sends no create, no update and no destroy, so nothing in the response names
  // a script — and this server drops an activation it cannot carry out without
  // an error. Reporting "active: invoices (sc-3)" would state as fact something
  // read before the write and never confirmed after it.
  const named = target === undefined ? id : describeScript(target);

  return {
    text: renderFields({
      asked: `make ${named} the script that filters incoming mail, from the next message on`,
      before:
        previous === undefined
          ? "no script was filtering when this call read the account"
          : previous.id === id
            ? `${named} was already the active script when this call read the account`
            : `${describeScript(previous)} was filtering when this call read the account, and ` +
              "only one script runs at a time, so this is what the activation stops",
      confirmed: NOT_CONFIRMED,
    }),
  };
}

/** What the activation displaces, named in the terms the caller has to weigh. */
function describeReplaced(active: SieveScript | undefined, id: Id): string {
  if (active === undefined) {
    return "Nothing filters incoming mail today, so this adds filtering where there was none.";
  }

  if (active.id === id) return "It is already the active script, so this changes nothing.";

  // Not a nicety: the account's vacation response is the active state of the
  // `vacation` script (`vacation/set.rs:144`), so replacing it as the active
  // script is what switches the automatic reply off — and nothing in the word
  // "activate" says the words "your automatic reply stops".
  return isVacationScript(active)
    ? `The vacation response is what is active today (${active.id}), and this switches that ` +
        "automatic reply off: nobody writing to the account will be answered any more."
    : `${describeScript(active)} stops filtering the moment this lands.`;
}

/* ------------------------------------------------------------- deactivate -- */

async function summarizeDeactivate(context: ToolContext): Promise<string> {
  const active = await activeScript(context);

  // Unreachable in practice: `precheckDeactivate` refuses this call before the
  // registry ever asks for a summary, and it decides on the same cached read, so
  // the two cannot disagree. The branch survives for the type — what follows
  // needs a script, not a `SieveScript | undefined` — and its sentence is there
  // only so the narrowing has something to return.
  if (active === undefined) {
    return "Switch off Sieve filtering, though nothing is filtering right now.";
  }

  return isVacationScript(active)
    ? "Switch off the vacation response, which is what is active: nobody writing to the account " +
        "will be answered automatically any more."
    : `Switch off ${describeScript(active)}, so no script filters incoming mail afterwards: ` +
        "every message lands where the server would put it untouched, including the ones this " +
        "script was filing away or refusing.";
}

/**
 * Refused rather than run when nothing is active.
 *
 * The call would succeed — clearing an already-clear active script is not an
 * error on this server — and that is the problem: it would be confirmed, run,
 * and report a change that never happened. A refusal says the account is
 * already in the state that was asked for.
 */
async function precheckDeactivate(context: ToolContext): Promise<string | undefined> {
  const active = await activeScript(context);

  return active === undefined
    ? "Refused: no script is active, so nothing filters incoming mail and there is nothing to " +
        "switch off. Nothing was changed."
    : undefined;
}

async function runDeactivate(context: ToolContext): Promise<ToolResult> {
  const previous = await activeScript(context);

  await context.client.request<SetResponse<SieveScript>>(
    [CAPABILITY_CORE, CAPABILITY_SIEVE],
    [
      "SieveScript/set",
      sieveActivationArguments(context.session.accountId, { deactivate: true }),
      "0",
    ],
  );

  // Same separation as the activation above, and for the same reason: the
  // account had this script filtering when the read landed, and the answer to a
  // switch-off names no script at all.
  return {
    text: renderFields({
      asked: "switch Sieve filtering off, so that no script filters incoming mail",
      before:
        // Unreachable for the same reason as the summary above: `precheck`
        // refused the no-active-script case on this same cached read. Kept for
        // the narrowing, not for a case that arrives.
        previous === undefined
          ? "nothing was active when this call read the account"
          : `${describeScript(previous)} was filtering when this call read the account`,
      confirmed: NOT_CONFIRMED,
      note: "the scripts themselves are untouched; sieve_write with action activate starts one again",
    }),
  };
}

/**
 * Said on both switches, and said the same way on each.
 *
 * `sieveActivationArguments` sends no `create`, no `update` and no `destroy`, so
 * the answer to either call carries no per-script result: the change lives in
 * `newState` and nowhere else. A report that named the new active script would
 * be quoting the read that ran before the write, which is exactly what this
 * module refuses to do elsewhere — an answer says what was asked of the server,
 * never what the server did with it.
 */
const NOT_CONFIRMED =
  "not by this answer. A SieveScript/set that only switches the active script reports the change " +
  "in newState and names no script, and this server drops an activation it cannot carry out " +
  "without raising an error. Run sieve_scripts with action list to read back what is active.";

/* ----------------------------------------------------------------- delete -- */

async function summarizeDelete(input: Input, context: ToolContext): Promise<string> {
  const ids = input.ids ?? [];
  const targets = await resolveTargets(ids, context);

  return (
    `Permanently destroy ${describeScripts(targets, ids.length)}. Sieve scripts have no trash: ` +
    "the source goes with them and no later call brings either back."
  );
}

async function precheckDelete(input: Input, context: ToolContext): Promise<string | undefined> {
  const ids = input.ids ?? [];

  // The ceiling first, before anything is read: fifty-one ids are refused
  // whatever they point at.
  const oversized = refuseOversizedBatch(ids, SIEVE_SCRIPTS);
  if (oversized !== undefined) return oversized;

  const scripts = await allScripts(context);
  const held = new Set(scripts.map((script) => script.id));

  const unknown = ids.filter((id) => !held.has(id));
  if (unknown.length > 0) {
    return (
      `Refused: the account holds no Sieve script with ${unknown.length === 1 ? "the id" : "the ids"} ` +
      `${unknown.join(", ")}. Nothing was destroyed. Run sieve_scripts with action list to see ` +
      "what is there."
    );
  }

  const active = scripts.find((script) => script.isActive === true && ids.includes(script.id));
  if (active !== undefined) {
    // The server refuses this one too, with `scriptIsActive`, but only after the
    // confirmation has been asked and answered.
    return (
      `Refused: ${describeScript(active)} is the script currently filtering incoming mail, and ` +
      "this server never removes the active script out from under the account. Nothing was " +
      "destroyed. Switch filtering off with action deactivate, or activate another script first."
    );
  }

  const vacation = scripts.find((script) => isVacationScript(script) && ids.includes(script.id));
  if (vacation !== undefined) {
    // The one path in this module where the client is the only guard: the
    // server's destroy branch tests the active-script condition and nothing else
    // (`sieve/set.rs:329-351`), so a `vacation` script handed to it is destroyed
    // and the account's automatic reply goes with it.
    return (
      `Refused: ${describeScript(vacation)} is the script the vacation response generates, and ` +
      "destroying it would take the automatic reply with it — this server would carry that out " +
      "without a word. Nothing was destroyed. Turn the reply off with vacation_manage instead."
    );
  }

  return undefined;
}

async function runDelete(input: Input, context: ToolContext): Promise<ToolResult> {
  const ids = input.ids ?? [];
  // Read before the destruction, so the report can name what disappeared: after
  // it, the ids point at nothing.
  const targets = await resolveTargets(ids, context);
  const named = new Map(targets.map((script) => [script.id, script.name ?? "(unnamed)"]));

  // `destroy` alone: an `update` riding along would rewrite scripts under a
  // confirmation read as a destruction, and both activation arguments are
  // written null by the factory, so nothing here switches what filters.
  const response = await context.client.request<SetResponse<SieveScript>>(
    [CAPABILITY_CORE, CAPABILITY_SIEVE],
    [
      "SieveScript/set",
      sieveScriptSetArguments(context.session.accountId, { destroy: [...ids] }),
      "0",
    ],
  );

  return {
    text: describeDestroyOutcome(response, ids, (id) => named.get(id) ?? "(unknown)"),
  };
}

/* ------------------------------------------------------------------ ------ */

/**
 * The source of a script, once per invocation, or nothing at all.
 *
 * `summarize` and `precheck` both need it — one to describe the activation, the
 * other to refuse it when it cannot be described — and two downloads could hand
 * back two different texts, refusing on one and confirming the other.
 *
 * A failure is `undefined` rather than an exception: an unreadable script is a
 * refusal this tool words itself, not a transport error the caller has to
 * interpret.
 */
function scriptSource(script: SieveScript, context: ToolContext): Promise<string | undefined> {
  return context.once(`sieve:text:${script.id}`, async () => {
    try {
      return await scriptText(script, context);
    } catch {
      return undefined;
    }
  });
}

/** The scripts an id set names, off the one shared read. */
async function resolveTargets(ids: readonly Id[], context: ToolContext): Promise<SieveScript[]> {
  const scripts = await allScripts(context);
  return ids
    .map((id) => scripts.find((script) => script.id === id))
    .filter((script): script is SieveScript => script !== undefined);
}

/** The refusal an id the account does not hold earns, wherever it came in. */
function unknownId(id: Id): string {
  return (
    `Refused: no Sieve script has the id ${id}. Run sieve_scripts with action list to see what ` +
    "the account holds."
  );
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

/**
 * What a store came to, and whether it landed.
 *
 * The flag rides with the text rather than being recomputed at the call site:
 * the caller has one more sentence to add when nothing was stored, and a second
 * copy of "did this land" would be free to disagree with this one.
 */
type StoreOutcome = { text: string; stored: boolean };

/** What a creation came to, read off `created` and nothing else. */
function describeCreated(response: SetResponse<SieveScript>, name: string): StoreOutcome {
  const created = response.created?.[CREATION_KEY];

  if (created === undefined) {
    const refused = response.notCreated?.[CREATION_KEY];
    return {
      stored: false,
      text:
        refused === undefined
          ? `Script ${name} was not created: the server said nothing, neither creating it nor refusing it.`
          : explainSetError(refused),
    };
  }

  return {
    stored: true,
    text: renderFields({
      stored: `Script ${name} created`,
      id: created.id,
      active: NOT_ACTIVATED,
    }),
  };
}

/** What a correction came to. `updated` may carry null, which is still a success. */
function describeUpdated(response: SetResponse<SieveScript>, input: Input): StoreOutcome {
  const id = input.id ?? "";

  if (response.updated !== undefined && id in response.updated) {
    return {
      stored: true,
      text: renderFields({
        stored: `Script ${input.name} replaced`,
        id,
        active: NOT_ACTIVATED,
      }),
    };
  }

  const refused = response.notUpdated?.[id];
  return {
    stored: false,
    text:
      refused === undefined
        ? `Script ${id} was not replaced: the server said nothing, neither updating it nor refusing it.`
        : explainSetError(refused),
  };
}

/**
 * Said on every successful store, and said in full.
 *
 * A script stored and not activated does nothing at all, and the difference is
 * invisible from the answer unless the answer names it: "stored" reads like
 * "in effect" to anybody who has not read the RFC.
 */
const NOT_ACTIVATED =
  "no — storing does not activate. Only one script filters at a time, and this call left that " +
  "unchanged.";
