import type { JmapSession } from "../jmap/session.js";

/**
 * The context the client receives at initialization.
 *
 * It answers, without spending a tool call, the questions an assistant would
 * otherwise ask first: whose mailbox is this, and what may I do with it. The
 * text is paid for on every initialization, so it stays short.
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

export function buildInstructions(session: JmapSession): string {
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
    "Every exposed tool reads. None writes, sends, moves or deletes, so nothing you do here can alter the mailbox.",
    "All tools act on that single account: an id one tool returns is meant to be passed to another.",
  ].join("\n\n");
}
