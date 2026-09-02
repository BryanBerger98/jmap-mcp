/**
 * The vacation response: reading it, and changing it one property at a time.
 *
 * Two things about this object are not visible from its name, and everything
 * here is shaped by them.
 *
 * The first is that its active state is not its own. `isEnabled` is read off the
 * `vacation` script's active flag (`vacation/set.rs:144`) and written back onto
 * it, so switching the reply on deactivates whatever script was filtering
 * (`vacation/set.rs:281-283`). One call moves two things, and only one of them
 * is named in the arguments.
 *
 * The second is that being on is not the same as answering. The generated script
 * carries the dates (`vacation/set.rs:330`), so a response left on with a window
 * that closed last month answers nobody — and an answer that printed `enabled:
 * yes` and stopped would be read as "people writing to me are being told".
 *
 * Nothing here reaches for a `SieveScript/*` method. The manifest is gated on the
 * vacation capability alone, which Stalwart grants through a permission separate
 * from the Sieve one (`api/session.rs:113` and `:118`): an account holding the
 * second without the first is plausible, and a read of the scripts would fail on
 * it. What the confirmation says about the script that stops filtering is
 * therefore said without naming it.
 */

import { z } from "zod";
import type { GetResponse, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_VACATION } from "../../jmap/types/core.js";
import type {
  VacationPatch,
  VacationResponse,
  VacationResponseGetArguments,
  VacationResponseSetArguments,
} from "../../jmap/types/sieve.js";
import { VACATION_SINGLETON_ID } from "../../jmap/types/sieve.js";
import { defineTool, type ToolContext, type ToolResult } from "../../registry/define-tool.js";
import { describeSetError, renderFields } from "../../shared/render.js";

/**
 * Every property the object has. Asked for by name rather than left to the
 * server's default set, so an answer that grew a property still renders the same.
 */
export const VACATION_PROPERTIES = [
  "id",
  "isEnabled",
  "fromDate",
  "toDate",
  "subject",
  "textBody",
  "htmlBody",
] as const;

/** What Stalwart accepts for the subject line, past which it answers a refusal. */
const MAX_SUBJECT = 512;

/** The same, for either body. Both are held to it independently. */
const MAX_BODY = 2048;

/** `UTCDate` as RFC 8621 §8 spells it: seconds, no milliseconds, trailing Z. */
const UTC_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const DATE_SHAPE = "a UTC date, e.g. 2026-09-10T00:00:00Z";

const inputSchema = z
  .strictObject({
    action: z
      .enum(["show", "set"])
      .describe(
        "What to do: read the automatic reply as it stands, or change it. `show` takes nothing else.",
      ),
    subject: z
      .string()
      .max(MAX_SUBJECT)
      .nullable()
      .optional()
      .describe(
        "On set, the subject of the automatic reply. Null clears it. Left out, the stored " +
          "subject is kept as it is.",
      ),
    textBody: z
      .string()
      .max(MAX_BODY)
      .nullable()
      .optional()
      .describe(
        "On set, the plain-text body of the reply. Null clears it. Left out, the stored body is " +
          "kept as it is.",
      ),
    htmlBody: z
      .string()
      .max(MAX_BODY)
      .nullable()
      .optional()
      .describe(
        "On set, the HTML body of the reply. Null clears it. Left out, the stored body is kept " +
          "as it is.",
      ),
    fromDate: z
      .string()
      .regex(UTC_DATE)
      .nullable()
      .optional()
      .describe(
        `On set, when the reply starts answering — ${DATE_SHAPE}. Null clears the bound, which ` +
          "makes the reply answer from the moment it is switched on.",
      ),
    toDate: z
      .string()
      .regex(UTC_DATE)
      .nullable()
      .optional()
      .describe(
        `On set, when it stops answering — ${DATE_SHAPE}. Null clears the bound, which makes the ` +
          "reply run until it is switched off.",
      ),
    isEnabled: z
      .boolean()
      .optional()
      .describe(
        "On set, whether the automatic reply answers at all. Left out, whatever it is today is " +
          "kept: changing the text never switches the reply on or off. Naming it is what makes " +
          "this call something the user is asked to confirm, in either direction.",
      ),
  })
  .refine((input) => input.action !== "set" || namesSomething(input), {
    message: "Name at least one property to change.",
    path: ["action"],
  })
  .refine((input) => input.action !== "show" || !namesSomething(input), {
    message:
      "`show` reads the automatic reply and takes no other argument; use `set` to change it.",
    path: ["action"],
  })
  .describe("Read or change the automatic reply the account sends while it is away.");

type Input = z.infer<typeof inputSchema>;

/** Every property a `set` may carry, in the order an answer lists them. */
const WRITABLE = ["subject", "textBody", "htmlBody", "fromDate", "toDate", "isEnabled"] as const;

export const vacationManage = defineTool({
  name: "vacation_manage",
  title: "Read or set the automatic reply",
  description:
    "Reads and changes the vacation response of the account: the automatic reply sent to whoever " +
    "writes while the account is away. " +
    "`show` returns the subject, both bodies, the window, whether the reply is switched on, and " +
    "whether it is answering today — a reply left on outside its window answers nobody. " +
    "`set` writes only the properties the call names: one left out is kept as it stands, one set " +
    "to null is cleared. Naming `isEnabled` is what switches the reply on or off, and nothing " +
    "else does. " +
    "Switching it on stops whatever Sieve script was filtering incoming mail: only one script " +
    "runs at a time, and the reply takes that place. " +
    "The script named `vacation` is what this tool writes; it is never stored, activated or " +
    "destroyed through sieve_write.",
  inputSchema,
  // Nothing here is destroyed and nothing is lost: a body replaced is a body the
  // caller wrote. What switching the reply on does is send mail — to everybody
  // who writes, without the account being asked again.
  classes: ["draft", "send"],
  classify: (input) => (isToggle(input) ? "send" : "draft"),
  summarize: async (input, context) => {
    if (!isToggle(input)) {
      return (
        `Change ${describeChanged(input)} of the automatic reply. Whether it answers at all is ` +
        "not touched by this call."
      );
    }

    const current = await readVacation(context);
    return input.isEnabled === true
      ? summarizeSwitchOn(input, current)
      : summarizeSwitchOff(input, current);
  },
  run: async (input, context) =>
    input.action === "show" ? runShow(context) : runSet(input, context),
});

/* -------------------------------------------------------------------- show -- */

async function runShow(context: ToolContext): Promise<ToolResult> {
  const current = await readVacation(context);

  if (current === undefined) {
    // No fallback and no invention: the account either has the singleton or the
    // server answered something this call cannot read as one.
    return {
      text:
        "The server returned no vacation response for this account, so there is nothing to " +
        "report. Nothing was changed.",
    };
  }

  return { text: describeVacation(current, new Date()) };
}

/**
 * The whole state of the reply, including the one thing it does not store: what
 * it is doing right now.
 *
 * `now` is a parameter rather than read here so the rendering can be tested at a
 * date of the test's choosing — the difference between "on" and "answering" is
 * the entire point of this function, and it only exists relative to an instant.
 */
export function describeVacation(response: VacationResponse, now: Date): string {
  const enabled = response.isEnabled === true;

  return renderFields({
    "automatic reply": enabled
      ? "on — the vacation script is the active one, so no other Sieve script is filtering"
      : "off — nobody writing to this account is answered automatically",
    "answering today": describeAnswering(response, now),
    window: describeWindow(response.fromDate ?? undefined, response.toDate ?? undefined),
    subject: response.subject ?? "(none — the reply carries no subject of its own)",
    "text body": response.textBody ?? "(none)",
    "html body": response.htmlBody ?? "(none)",
  });
}

/**
 * Whether a message arriving now is answered, which is not what `isEnabled` says.
 *
 * The dates end up inside the generated script (`vacation/set.rs:330`), so the
 * server keeps answering "enabled" for a response whose window closed. Both ways
 * of being on without answering are named rather than folded into one "no": a
 * window that has not opened yet is a plan, one that has closed is a leftover,
 * and they call for opposite corrections.
 */
function describeAnswering(response: VacationResponse, now: Date): string {
  if (response.isEnabled !== true) return "no — the reply is switched off";

  const from = instantOf(response.fromDate);
  const to = instantOf(response.toDate);

  if (from === "unreadable" || to === "unreadable") {
    return (
      "unknown — the server returned a date this call cannot read, so whether the window is open " +
      "today cannot be told from here"
    );
  }

  const at = now.getTime();
  if (from !== undefined && at < from) {
    return `no — it is switched on, but its window only opens on ${response.fromDate}`;
  }
  if (to !== undefined && at >= to) {
    return `no — it is switched on, but its window closed on ${response.toDate}`;
  }

  return "yes — a message arriving now gets the automatic reply below";
}

/** The window in one line, and never as two empty fields. */
function describeWindow(from: string | undefined, to: string | undefined): string {
  if (from === undefined && to === undefined) {
    return "endless — no start and no end, so it answers for as long as it is switched on";
  }
  if (to === undefined) return `from ${from} onwards, with no end`;
  if (from === undefined) return `until ${to}, with no start of its own`;

  return `from ${from} until ${to}`;
}

/* --------------------------------------------------------------------- set -- */

async function runSet(input: Input, context: ToolContext): Promise<ToolResult> {
  const patch = buildVacationPatch(input);

  // Read before the write: afterwards the object carries what this call just
  // wrote, and a report saying the reply "is still off" would be reading its own
  // change back.
  const before = await readVacation(context);

  const args: VacationResponseSetArguments = {
    accountId: context.session.accountId,
    // One update, on the one id this object has. Neither `create` nor `destroy`
    // is representable on the arguments type: the server refuses both on a
    // singleton, and a round trip is a poor way to learn that.
    update: { [VACATION_SINGLETON_ID]: patch },
  };

  const response = await context.client.request<SetResponse<VacationResponse>>(
    [CAPABILITY_CORE, CAPABILITY_VACATION],
    ["VacationResponse/set", args, "0"],
  );

  if (response.updated === undefined || !(VACATION_SINGLETON_ID in response.updated)) {
    const refused = response.notUpdated?.[VACATION_SINGLETON_ID];
    return {
      text:
        refused === undefined
          ? "The automatic reply was not changed: the server neither updated it nor said why."
          : `Refused by the server: ${describeSetError(refused)} Nothing was changed.`,
    };
  }

  return { text: describeOutcome(input, patch, before) };
}

/**
 * The patch, carrying the properties the call named and no others.
 *
 * A key absent leaves the property where it is, a key set to null clears it
 * (`vacation/set.rs:214-218`), and the two are told apart by `undefined` — which
 * JSON cannot express, so an argument that is undefined here was absent from the
 * call. `isEnabled` obeys the same rule and matters most: the server preserves it
 * across a change of text, so writing it unasked would switch the reply on or off
 * under a confirmation that spoke of wording.
 */
export function buildVacationPatch(input: {
  subject?: string | null | undefined;
  textBody?: string | null | undefined;
  htmlBody?: string | null | undefined;
  fromDate?: string | null | undefined;
  toDate?: string | null | undefined;
  isEnabled?: boolean | undefined;
}): VacationPatch {
  const patch: VacationPatch = {};

  if (input.subject !== undefined) patch.subject = input.subject;
  if (input.textBody !== undefined) patch.textBody = input.textBody;
  if (input.htmlBody !== undefined) patch.htmlBody = input.htmlBody;
  if (input.fromDate !== undefined) patch.fromDate = input.fromDate;
  if (input.toDate !== undefined) patch.toDate = input.toDate;
  if (input.isEnabled !== undefined) patch.isEnabled = input.isEnabled;

  return patch;
}

/**
 * What the call came to, with the active state stated either way.
 *
 * A `draft` call says the reply did not move, in as many words. "Subject
 * changed" reads as "the reply is now what I wrote" to anybody who has not
 * followed which argument does what, and the account may have been answering
 * every sender for a month.
 */
function describeOutcome(
  input: Input,
  patch: VacationPatch,
  before: VacationResponse | undefined,
): string {
  const written = WRITABLE.filter((property) => property in patch)
    .map((property) =>
      patch[property] === null ? `${label(property)} (cleared)` : label(property),
    )
    .join(", ");

  if (!isToggle(input)) {
    const state =
      before === undefined
        ? "unchanged — this call did not touch whether the reply answers"
        : before.isEnabled === true
          ? "unchanged — the reply was already on and is still on, and this call did not touch that"
          : "unchanged — the reply was off and is still off, so nothing is being sent";

    return renderFields({ changed: written, "automatic reply": state });
  }

  const on = input.isEnabled === true;
  const from = merged(input.fromDate, before?.fromDate);
  const to = merged(input.toDate, before?.toDate);

  return renderFields({
    changed: written,
    "automatic reply": on
      ? "on — whoever writes to this account is answered automatically"
      : "off — nobody writing to this account is answered any more",
    window: on ? describeWindow(from, to) : "unchanged; it applies again the next time it is on",
    filtering: on
      ? "the vacation script is the active one now, so no other Sieve script filters incoming mail"
      : "no Sieve script is active any more; sieve_write with action activate starts one again",
  });
}

/* ------------------------------------------------------------ confirmation -- */

/**
 * What switching the reply on commits the account to.
 *
 * Three things, and none of them is in the arguments: who gets answered, over
 * what window — the stored bounds, when the call names none — and what stops
 * filtering. The last one has no name here on purpose: reading it would take a
 * `SieveScript/get`, which this manifest is not gated on and an account may not
 * be allowed to make.
 */
function summarizeSwitchOn(input: Input, current: VacationResponse | undefined): string {
  const from = merged(input.fromDate, current?.fromDate);
  const to = merged(input.toDate, current?.toDate);
  const subject = merged(input.subject, current?.subject);

  const already = current?.isEnabled === true ? " It is already on, so this leaves it on." : "";

  return (
    "Switch the automatic reply on: everybody who writes to this account is answered by the " +
    `server, ${describeWindow(from, to)}. The reply goes out under the subject ` +
    `${subject === undefined ? "the server picks" : `"${subject}"`}. Whatever Sieve script is ` +
    "filtering incoming mail stops being the active one the moment this lands — only one script " +
    `runs at a time, and the vacation script takes that place.${already}`
  );
}

/** The other direction, confirmed the same way and for the symmetrical reason. */
function summarizeSwitchOff(input: Input, current: VacationResponse | undefined): string {
  const already =
    current?.isEnabled === false
      ? " It is already off, so this leaves it off."
      : " No Sieve script is active afterwards, so nothing filters incoming mail either.";

  const changed = describeChanged(input, ["isEnabled"]);
  const alongside = changed === "" ? "" : ` It also changes ${changed}.`;

  return (
    "Switch the automatic reply off: nobody writing to this account is answered automatically " +
    `any more, from the moment this lands.${already}${alongside}`
  );
}

/* ------------------------------------------------------------------ ------ -- */

/**
 * The vacation response as it stands, once per handler invocation.
 *
 * `summarize` needs it to say what a toggle is switching on, and `run` needs it
 * to say what the active state was before. Two reads could disagree across a
 * confirmation, and the report would then be about a state nobody confirmed.
 */
export async function readVacation(context: ToolContext): Promise<VacationResponse | undefined> {
  const args: VacationResponseGetArguments = {
    accountId: context.session.accountId,
    // The one id the server accepts: the object is a singleton per account.
    ids: [VACATION_SINGLETON_ID],
    properties: [...VACATION_PROPERTIES],
  };

  const response = await context.once("sieve:vacation", () =>
    context.client.request<GetResponse<VacationResponse>>(
      [CAPABILITY_CORE, CAPABILITY_VACATION],
      ["VacationResponse/get", args, "0"],
    ),
  );

  return response.list.find((each) => each.id === VACATION_SINGLETON_ID) ?? response.list[0];
}

/** Whether this call moves the active state, which is what makes it a send. */
function isToggle(input: { action?: unknown; isEnabled?: unknown }): boolean {
  return input.action === "set" && input.isEnabled !== undefined;
}

/** Whether a call names any property at all, beyond the action itself. */
function namesSomething(input: { [K in (typeof WRITABLE)[number]]?: unknown }): boolean {
  return WRITABLE.some((property) => input[property] !== undefined);
}

/** The properties a call names, in words, for a sentence that has to read. */
function describeChanged(input: Input, except: readonly string[] = []): string {
  const named = WRITABLE.filter(
    (property) => input[property] !== undefined && !except.includes(property),
  ).map((property) =>
    input[property] === null ? `${label(property)} (cleared)` : label(property),
  );

  return named.join(", ");
}

/** Property names as a person says them, not as the protocol spells them. */
function label(property: (typeof WRITABLE)[number]): string {
  switch (property) {
    case "textBody":
      return "the text body";
    case "htmlBody":
      return "the HTML body";
    case "fromDate":
      return "the start of the window";
    case "toDate":
      return "the end of the window";
    case "isEnabled":
      return "whether it answers";
    default:
      return "the subject";
  }
}

/**
 * What a property will be worth once this call lands: what it names, or what is
 * stored when it names nothing.
 *
 * Null and undefined collapse here, and only here: a bound cleared and a bound
 * that was never set describe the same window to whoever is reading the question.
 */
function merged(
  named: string | null | undefined,
  stored: string | null | undefined,
): string | undefined {
  return (named === undefined ? stored : named) ?? undefined;
}

/**
 * A date as milliseconds, or a marker saying it could not be read.
 *
 * A date the server returned in a shape this call does not parse is not treated
 * as an absent bound: an unbounded window and an unreadable one lead to opposite
 * statements about whether the account is answering.
 */
function instantOf(date: string | null | undefined): number | undefined | "unreadable" {
  if (date === null || date === undefined) return undefined;

  const parsed = Date.parse(date);
  return Number.isNaN(parsed) ? "unreadable" : parsed;
}
