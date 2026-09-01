/**
 * Deleting an event, silently by default, cancelling it on request.
 *
 * This is the first call of the server whose class is `destroy` while its side
 * effect is a send: `notify` turns the deletion into an iTIP cancellation mailed
 * to every participant. The policy is read here rather than trusted to the
 * registry, which classifies the call once and cannot see that a `destroy` also
 * carries a `send` — a configuration denying sends would otherwise be walked
 * straight past.
 */

import { z } from "zod";
import { checkRecipients } from "../../config/recipients.js";
import type {
  CalendarEvent,
  CalendarEventGetArguments,
  CalendarEventSetArguments,
} from "../../jmap/types/calendars.js";
import type { GetResponse, Id, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CALENDARS, CAPABILITY_CORE } from "../../jmap/types/core.js";
import { defineTool, type ToolContext } from "../../registry/define-tool.js";
import { refuseOversizedBatch } from "../../shared/batch.js";
import {
  CALENDAR_EVENTS,
  describeEventOutcome,
  EVENT_WRITE_PROPERTIES,
  refuseIsolatedOccurrence,
} from "./edit.js";
import { eventTitle } from "./event.js";

/** How many events a confirmation spells out before it counts the rest. */
const NAMED_IN_SUMMARY = 5;

const inputSchema = z.object({
  ids: z
    .array(z.string())
    .min(1)
    .describe("The ids of the events to delete, as returned by calendar_search or calendar_read."),
  notify: z
    .boolean()
    .optional()
    .describe(
      "Whether the server should mail a cancellation to the participants. " +
        "False by default: the event is removed from this account and nobody is told.",
    ),
});

type DeleteInput = z.infer<typeof inputSchema>;

export const calendarDelete = defineTool({
  name: "calendar_delete",
  title: "Delete calendar events",
  description:
    "Deletes the named events from this account. This is permanent: an event removed here is " +
    "not filed anywhere, and no later call brings it back. " +
    "A recurring event is deleted whole, every occurrence of the series included — cancelling a " +
    "single occurrence of a series is not something this server does, and an occurrence id is " +
    "refused rather than silently turned into one. " +
    "notify decides whether the participants are mailed a cancellation: false by default, so a " +
    "deletion stays inside the account unless you ask for it and confirm it. " +
    "It acts on event ids only — run calendar_search first and pass the ids it returns.",
  inputSchema,
  // One class whatever `notify` says: a deletion is a destruction, and notifying
  // widens who learns about it rather than softening what it does.
  classes: ["destroy"],
  classify: () => "destroy",
  summarize: (input, context) => summarize(input, context),
  precheck: (input, context) => refuse(input, context),
  run: async (input, context) => {
    // Checked again on the way in, and not only because `precheck` looked: the
    // reads go through `context.once`, so asking twice costs one round trip and
    // no hook has the last word on a destruction.
    const refusal = await refuse(input, context);
    if (refusal !== undefined) return { text: refusal };

    const args: CalendarEventSetArguments = {
      accountId: context.session.accountId,
      // `destroy` alone: an `update` riding along would change events under a
      // confirmation the user read as a deletion, and a `create` would add one.
      destroy: [...input.ids],
      sendSchedulingMessages: input.notify === true,
    };

    const response = await context.client.request<SetResponse<CalendarEvent>>(
      [CAPABILITY_CORE, CAPABILITY_CALENDARS],
      ["CalendarEvent/set", args, "0"],
    );

    const lines = [
      describeEventOutcome(response, input.ids, "destroyed", "destroyed"),
      schedulingNote(input),
    ];

    return { text: lines.join("\n\n") };
  },
});

/**
 * Everything that makes the call vain, before anything is destroyed.
 *
 * The policy check comes first, and before any read: an account whose
 * configuration denies sends must not spend a round trip discovering that the
 * cancellation it asked for was never going to leave.
 */
async function refuse(input: DeleteInput, context: ToolContext): Promise<string | undefined> {
  if (input.notify === true && context.policy.send === "deny") {
    return (
      "Refused: this call would have the server mail a cancellation to the participants, and " +
      "policy.send is set to deny in the configuration. Call again without notify to delete the " +
      "events without telling anyone, or lift policy.send first."
    );
  }

  const oversized = refuseOversizedBatch(input.ids, CALENDAR_EVENTS);
  if (oversized !== undefined) return oversized;

  // Whether an id names a whole event or one expanded occurrence is an answer
  // only the server carries, so this refusal costs the read.
  const events = await readEvents(input.ids, context);

  const isolated = refuseIsolatedOccurrence(events);
  if (isolated !== undefined) return isolated;

  if (input.notify !== true) return undefined;

  const addressed = participantsOf(events);
  if (addressed.length === 0) return undefined;

  const check = checkRecipients(addressed, context.recipients);
  return check.ok ? undefined : check.refusal;
}

/**
 * The sentence a person reads before confirming.
 *
 * It runs ahead of the refusals, so a read it only needed for its wording
 * degrades to a count rather than failing the call — the `contacts_delete`
 * pattern: confirming "3 events" is confirming a number, but a transport hiccup
 * must not turn into a verdict on the call either.
 */
async function summarize(input: DeleteInput, context: ToolContext): Promise<string> {
  const counted = `${input.ids.length} event${input.ids.length === 1 ? "" : "s"}`;

  try {
    const events = await readEvents(input.ids, context);

    const named = events
      .slice(0, NAMED_IN_SUMMARY)
      .map((event) => `${eventTitle(event)} (${describeWhen(event)})`)
      .join(", ");

    const more =
      events.length > NAMED_IN_SUMMARY ? `, and ${events.length - NAMED_IN_SUMMARY} more` : "";

    return [
      named === ""
        ? `Permanently delete ${counted}.`
        : `Permanently delete ${counted}: ${named}${more}.`,
      seriesNote(events),
      mailingNote(input, events),
      "Nothing recovers them afterwards.",
    ]
      .filter((line): line is string => line !== undefined)
      .join(" ");
  } catch {
    const blind =
      input.notify === true
        ? "The server is asked to mail a cancellation to their participants."
        : "No cancellation is mailed: nobody else is told.";

    return `Permanently delete ${counted}. ${blind} Nothing recovers them afterwards.`;
  }
}

/** Whether a cancellation leaves, and to how many people, before it is confirmed. */
function mailingNote(input: DeleteInput, events: readonly CalendarEvent[]): string {
  if (input.notify !== true) {
    return "No cancellation is mailed: the events leave this account and nobody else is told.";
  }

  const addressed = participantsOf(events);
  return addressed.length === 0
    ? "The server is asked to mail a cancellation, but these events carry no participant to reach."
    : `The server is asked to mail a cancellation to ${addressed.length} participant` +
        `${addressed.length === 1 ? "" : "s"} (${addressed.join(", ")}).`;
}

/**
 * What the call asked of the scheduling side, never what the server did with it.
 *
 * The three conditions that swallow a scheduling message without an error are
 * the ones `calendar_write` names, and a cancellation is subject to all three: a
 * successful `CalendarEvent/set` proves the event is gone, and nothing more.
 */
function schedulingNote(input: DeleteInput): string {
  return input.notify === true
    ? "The server was asked to mail a cancellation to the participants. Whether it did cannot be " +
        "read from its answer: it skips scheduling silently when iTIP is off, when the account " +
        "lacks the scheduling permission, or when the event is entirely in the past."
    : "No cancellation was mailed: the events were removed from this account and the participants " +
        "were not told. Call again with notify to have the server cancel them properly.";
}

/** Says out loud that deleting a rule-bearing event takes every occurrence with it. */
function seriesNote(events: readonly CalendarEvent[]): string | undefined {
  const recurring = events.filter((event) => (event.recurrenceRules?.length ?? 0) > 0);
  if (recurring.length === 0) return undefined;

  const named = recurring.map((event) => event.id).join(", ");
  return (
    `${named} ${recurring.length === 1 ? "is a recurring event" : "are recurring events"}: the ` +
    "whole series disappears, every occurrence included, not one date of it."
  );
}

/** One event's start as the event itself states it, zone included. */
function describeWhen(event: CalendarEvent): string {
  if (event.start === undefined) return "no start";
  return event.timeZone === undefined ? event.start : `${event.start} ${event.timeZone}`;
}

/**
 * Every address a cancellation would reach, once, across the whole batch.
 *
 * Deduplicated on the folded address and rendered as the event spells it: the
 * same person on three deleted events is one recipient to check, and a
 * confirmation counting them three times overstates what is about to leave.
 */
function participantsOf(events: readonly CalendarEvent[]): string[] {
  const seen = new Map<string, string>();

  for (const event of events) {
    for (const participant of Object.values(event.participants ?? {})) {
      const address = participant.email ?? participant.calendarAddress;
      if (address === undefined || address.trim() === "") continue;

      const bare = bareAddress(address);
      if (!seen.has(bare.toLowerCase())) seen.set(bare.toLowerCase(), bare);
    }
  }

  return [...seen.values()];
}

/** `mailto:` is how iTIP addresses a person; a perimeter is a list of addresses. */
function bareAddress(address: string): string {
  const trimmed = address.trim();
  return trimmed.toLowerCase().startsWith("mailto:") ? trimmed.slice("mailto:".length) : trimmed;
}

/**
 * The events this call is about, read once per handler invocation.
 *
 * The same properties every calendar write reads, `baseEventId` included: an
 * expanded occurrence has to be told from a whole event before either is
 * destroyed, and only the server knows which one an id names.
 */
function readEvents(ids: readonly Id[], context: ToolContext): Promise<CalendarEvent[]> {
  return context.once(`calendar:delete:${[...ids].sort().join(",")}`, async () => {
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
  });
}
