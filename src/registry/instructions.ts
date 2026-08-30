import { OPERATION_CLASSES, type OperationClass } from "../config/policy.js";
import type { JmapSession } from "../jmap/session.js";

/**
 * The context the client receives at initialization.
 *
 * It answers, without spending a tool call, the questions an assistant would
 * otherwise ask first: whose mailbox is this, and what may I do with it. The
 * text is paid for on every initialization, so it stays short.
 *
 * "What may I do" is answered from the operation classes the registry left
 * reachable, never from a literal: the answer is a promise made to the client.
 */

/** Capability URIs mapped to a name a human reads. Anything else is dropped. */
const DOMAIN_NAMES: Record<string, string> = {
  "urn:ietf:params:jmap:mail": "Mail",
  "urn:ietf:params:jmap:submission": "Sending",
  "urn:ietf:params:jmap:vacationresponse": "Vacation response",
  "urn:ietf:params:jmap:sieve": "Sieve filters",
  "urn:ietf:params:jmap:contacts": "Contacts",
  "urn:ietf:params:jmap:calendars": "Calendars",
  "urn:ietf:params:jmap:filenode": "Files",
  "urn:ietf:params:jmap:principals": "Sharing",
};

/**
 * The innocuousness promise. Sent only when the exposed surface is read-only,
 * and exported so a test can assert its presence without freezing its wording.
 */
export const READ_ONLY_PROMISE =
  "Every exposed tool reads. None writes, sends, moves or deletes, so nothing you do here can alter the mailbox.";

/** What each operation class lets the assistant do, in the client's terms. */
const CLASS_EFFECTS: Record<OperationClass, string> = {
  read: "read",
  draft: "create and change drafts",
  send: "send messages",
  destroy: "move or delete data",
};

/**
 * States what the exposed tools can do, derived from the classes the registry
 * actually left reachable. A literal here would keep promising innocuousness
 * the day a write domain is registered.
 */
function scopeSentence(classes: ReadonlySet<OperationClass>): string {
  if (classes.size === 0) {
    return "No tool is exposed: the advertised capabilities and the configured policy left none.";
  }

  if (classes.size === 1 && classes.has("read")) {
    return READ_ONLY_PROMISE;
  }

  const effects = OPERATION_CLASSES.filter((operation) => classes.has(operation)).map(
    (operation) => CLASS_EFFECTS[operation],
  );

  return `Exposed tools can ${enumerate(effects)}: this session is not read-only, and each call is classified before it runs.`;
}

function enumerate(items: readonly string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function buildInstructions(
  session: JmapSession,
  classes: ReadonlySet<OperationClass>,
): string {
  const account = session.account;
  const kind = account.isPersonal ? "personal" : "shared";

  const domains = session
    .capabilities()
    .map((capability) => DOMAIN_NAMES[capability])
    .filter((name): name is string => name !== undefined);

  const advertised =
    domains.length > 0
      ? `This server advertises: ${domains.join(", ")}.`
      : "This server advertises no recognised domain.";

  return [
    `You are connected to one JMAP mailbox: the ${kind} account "${account.name}", opened as ${session.username}.`,
    advertised,
    scopeSentence(classes),
    "All tools act on that single account: an id one tool returns is meant to be passed to another.",
  ].join("\n\n");
}
