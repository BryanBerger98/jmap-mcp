/**
 * Answering an invitation, and answering nothing else.
 *
 * The safety of this tool is a shape rather than a check: every patch it emits
 * is a pointer into `participants/{key}/`, where the key is the participant the
 * account was proven to occupy. Writing the `participants` map whole would erase
 * the other guests, and writing another key would answer on somebody's behalf —
 * neither is reachable from a pointer that can only ever carry the account's own
 * status and comment.
 *
 * The key is proven by `matchingParticipantKey`, never guessed: zero matches and
 * several matches both refuse, because a reply that has left cannot be recalled.
 */

import { z } from "zod";
import { checkRecipients } from "../../config/recipients.js";
import type {
  CalendarEvent,
  CalendarEventGetArguments,
  CalendarEventSetArguments,
  EventPatch,
} from "../../jmap/types/calendars.js";
import type { GetResponse, Id, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CALENDARS, CAPABILITY_CORE } from "../../jmap/types/core.js";
import { defineTool, type ToolContext } from "../../registry/define-tool.js";
import { refuseOversizedBatch } from "../../shared/batch.js";
import {
  bareAddress,
  CALENDAR_EVENTS,
  describeEventOutcome,
  EVENT_WRITE_PROPERTIES,
  matchingParticipantKey,
  NAMED_IN_SUMMARY,
  refuseIsolatedOccurrence,
  resolveParticipantIdentities,
} from "./edit.js";
import { eventTitle } from "./event.js";

const inputSchema = z.object({
  eventIds: z
    .array(z.string())
    .min(1)
    .describe(
      "The ids of the invitations to answer, as returned by calendar_search or calendar_read.",
    ),
  status: z
    .enum(["accepted", "declined", "tentative"])
    .describe("The answer to record for this account, and this account only."),
  comment: z
    .string()
    .optional()
    .describe("A free-form note sent along with the answer, e.g. why you decline."),
  notify: z
    .boolean()
    .optional()
    .describe(
      "Whether the server should mail the answer to the organiser. True by default: " +
        "an answer nobody receives has not answered anything. Pass false to record it locally.",
    ),
});

type RespondInput = z.infer<typeof inputSchema>;

/** One event this call can answer, with the participant key the account holds. */
interface Answer {
  event: CalendarEvent;
  key: string;
}

interface Resolution {
  answers: Answer[];
  /** Ids the read never returned: never patched blind, always reported. */
  missing: Id[];
}

export const calendarRespond = defineTool({
  name: "calendar_respond",
  title: "Answer an invitation received in the calendar",
  description:
    "Accepts, declines or tentatively answers invitations this account received. " +
    "It writes one thing and one thing only: the participation status of this account on the " +
    "event, plus the comment you give it. The status of every other participant, and every other " +
    "property of the event, is left untouched. " +
    "The account's own participant entry is matched against the calendar addresses the server " +
    "holds for it, and an event where none or several of them appear is refused rather than " +
    "answered on a guess. " +
    "notify decides whether the organiser is mailed about it: true by default, since an answer " +
    "that never reaches the organiser has answered nothing.",
  inputSchema,
  // A reply is a mail unless it is explicitly held back, so the default class is
  // the one that gets confirmed.
  classes: ["draft", "send"],
  classify: (input) => (input.notify === false ? "draft" : "send"),
  summarize: (input, context) => summarize(input, context),
  precheck: async (input, context) => {
    // First of everything, the open perimeter included. Placed after the early
    // return below, an oversized batch on the common configuration would reach
    // `summarize`, spend its two reads and be put to the user, only to be
    // refused by `run` once the answer came back.
    const oversized = refuseOversizedBatch(input.eventIds, CALENDAR_EVENTS);
    if (oversized !== undefined) return oversized;

    // An open perimeter costs nothing more: nothing else is read at all.
    if (context.recipients.kind === "anyone") return undefined;

    // Every other refusal belongs to `run`, which reports it in its own words:
    // a failed read here must not turn a transport error into a refusal.
    const resolved = await resolve(input, context).catch(() => undefined);
    if (resolved === undefined || "refusal" in resolved) return undefined;

    return outsidePerimeter(resolved.answers, context);
  },
  confirmWhen: (input, context) => {
    const count = input.eventIds.length;
    return Promise.resolve(
      count > context.bulkConfirmAbove
        ? `This answers ${count} invitations at once, past the ${context.bulkConfirmAbove} this ` +
            "server writes without asking."
        : undefined,
    );
  },
  run: async (input, context) => {
    // Checked again, and not only because `precheck` looked: no hook has the
    // last word on how much one call writes.
    const oversized = refuseOversizedBatch(input.eventIds, CALENDAR_EVENTS);
    if (oversized !== undefined) return { text: oversized };

    const resolved = await resolve(input, context);
    if ("refusal" in resolved) return { text: resolved.refusal };

    // Checked again on what is about to be written, and not only because
    // `precheck` looked: that hook swallows a failed read, so it cannot have the
    // last word on who a message reaches.
    const outside = outsidePerimeter(resolved.answers, context);
    if (outside !== undefined) return { text: outside };

    return write(input, resolved, context);
  },
});

/**
 * The events this call can answer, or the reason it can answer none of them.
 *
 * One refusal stops the whole call rather than skipping the offending event: a
 * caller who asked for three answers and silently got two has no way of knowing
 * which invitation still awaits them.
 */
function resolve(
  input: RespondInput,
  context: ToolContext,
): Promise<Resolution | { refusal: string }> {
  return context.once(`calendar:respond:${[...input.eventIds].sort().join(",")}`, async () => {
    const events = await readEvents(input.eventIds, context);

    const isolated = refuseIsolatedOccurrence(events);
    if (isolated !== undefined) return { refusal: isolated };

    const identities = await resolveParticipantIdentities(context);

    const answers: Answer[] = [];
    for (const event of events) {
      const matched = matchingParticipantKey(event, identities);
      if (matched.refusal !== undefined) return { refusal: matched.refusal };

      answers.push({ event, key: matched.key });
    }

    const found = new Set(events.map((event) => event.id));
    return { answers, missing: input.eventIds.filter((id) => !found.has(id)) };
  });
}

/** Writes the one status, and accounts for every id the server refused. */
async function write(input: RespondInput, resolved: Resolution, context: ToolContext) {
  const update: Record<Id, EventPatch> = {};
  for (const { event, key } of resolved.answers) {
    const patch: EventPatch = { [`participants/${key}/participationStatus`]: input.status };
    if (input.comment !== undefined)
      patch[`participants/${key}/participationComment`] = input.comment;

    update[event.id] = patch;
  }

  const args: CalendarEventSetArguments = {
    accountId: context.session.accountId,
    update,
    sendSchedulingMessages: input.notify !== false,
  };

  const response = await context.client.request<SetResponse<CalendarEvent>>(
    [CAPABILITY_CORE, CAPABILITY_CALENDARS],
    ["CalendarEvent/set", args, "0"],
  );

  const answered = Object.keys(update);
  const lines = [
    answered.length === 0
      ? "Nothing was answered: none of the given ids named an invitation this account is on."
      : describeEventOutcome(response, answered, `marked ${input.status}`),
    resolved.missing.length === 0 ? undefined : `Not found: ${resolved.missing.join(", ")}`,
    describeAnswers(resolved.answers),
    schedulingNote(input, resolved.answers),
  ];

  return { text: lines.filter((line): line is string => line !== undefined).join("\n\n") };
}

/** Who answered, and to whom, so neither has to be taken on trust. */
function describeAnswers(answers: readonly Answer[]): string | undefined {
  if (answers.length === 0) return undefined;

  const rendered = answers.map(
    ({ event, key }) =>
      `${event.id}: answered as ${participantAddress(event, key)}, organiser ` +
      `${organizerOf(event) ?? "(none named on the event)"}`,
  );

  return rendered.join("\n");
}

/**
 * What the call asked of the scheduling side, never what the server did with it.
 *
 * The three conditions that swallow a scheduling message without an error are
 * the ones `calendar_write` names, and they apply to a reply exactly as they do
 * to an invitation: a successful `CalendarEvent/set` proves the status was
 * written, and nothing beyond that.
 */
function schedulingNote(input: RespondInput, answers: readonly Answer[]): string | undefined {
  if (input.notify === false) {
    return (
      "No reply was mailed: the status was written onto the event and the organiser was not " +
      "told. Call again without notify to have the server send it."
    );
  }

  const asked =
    "The server was asked to mail the answer to the organiser. Whether it did cannot be read " +
    "from its answer: it skips scheduling silently when iTIP is off, when the account lacks the " +
    "scheduling permission, or when the event is entirely in the past.";

  const orphaned = answers.filter(({ event }) => organizerOf(event) === undefined);
  if (orphaned.length === 0) return asked;

  const named = orphaned.map(({ event }) => event.id).join(", ");
  return `${asked}\n\nNote: ${named} names no organiser, so the reply has nobody to reach.`;
}

/** The sentence a person reads before confirming: who, what, and to whom. */
async function summarize(input: RespondInput, context: ToolContext): Promise<string> {
  const ids = input.eventIds;
  const counted = `${ids.length} invitation${ids.length === 1 ? "" : "s"}`;

  const mailing =
    input.notify === false
      ? "The organiser is not told: the status stays in this account."
      : "The server is asked to mail the answer to the organiser.";

  const resolved = await resolve(input, context).catch(() => undefined);
  if (resolved === undefined || "refusal" in resolved) {
    return `Answer ${counted} as ${input.status}. ${mailing}`;
  }

  const named = resolved.answers
    .slice(0, NAMED_IN_SUMMARY)
    .map(({ event }) => `${eventTitle(event)} (organiser ${organizerOf(event) ?? "none"})`)
    .join(", ");

  const more =
    resolved.answers.length > NAMED_IN_SUMMARY
      ? `, and ${resolved.answers.length - NAMED_IN_SUMMARY} more`
      : "";

  const heading = named === "" ? `Answer ${counted}` : `Answer ${counted}: ${named}${more}`;
  return `${heading}, as ${input.status}. ${mailing}`;
}

/**
 * The organisers this call would write to, checked against the perimeter.
 *
 * The check does not wait for `notify`: recording an answer is a gesture aimed
 * at the organiser, and a perimeter that let it through when the mail is held
 * back would be a perimeter about transport rather than about who this account
 * corresponds with.
 */
function outsidePerimeter(answers: readonly Answer[], context: ToolContext): string | undefined {
  const organizers = answers
    .map(({ event }) => organizerOf(event))
    .filter((address): address is string => address !== undefined);

  if (organizers.length === 0) return undefined;

  const check = checkRecipients(organizers, context.recipients);
  return check.ok ? undefined : check.refusal;
}

/** The organiser of an event, as an address rather than as a URI. */
function organizerOf(event: CalendarEvent): string | undefined {
  const address = event.organizerCalendarAddress?.trim();
  return address === undefined || address === "" ? undefined : bareAddress(address);
}

/** The address the account answers under, for an answer that names itself. */
function participantAddress(event: CalendarEvent, key: string): string {
  const participant = event.participants?.[key];
  const address = participant?.email ?? participant?.calendarAddress;
  return address === undefined ? key : bareAddress(address);
}

/**
 * The invitations this call is about, read once per handler invocation.
 *
 * The same property list every calendar write reads from, and for the same
 * reason it excludes `utcStart`: a patch is computed from what came back, and
 * the draft refuses the computed bounds next to the local ones.
 */
async function readEvents(ids: readonly Id[], context: ToolContext): Promise<CalendarEvent[]> {
  const args: CalendarEventGetArguments = {
    accountId: context.session.accountId,
    ids: [...ids],
    properties: [...EVENT_WRITE_PROPERTIES],
  };

  const response = await context.client.request<GetResponse<CalendarEvent>>(
    [CAPABILITY_CORE, CAPABILITY_CALENDARS],
    ["CalendarEvent/get", args, "0"],
  );

  return response.list;
}
