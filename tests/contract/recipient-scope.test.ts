import type { McpServer } from "@modelcontextprotocol/server";
import { isInputRequiredResult } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { type RecipientScope, restrictTo } from "../../src/config/recipients.js";
import { mailSendingDomain } from "../../src/domains/mail/index.js";
import type { GetResponse, JmapRequest, SetResponse } from "../../src/jmap/types/core.js";
import type { Email, EmailSubmission, Identity, Mailbox } from "../../src/jmap/types/mail.js";
import { compose } from "../../src/registry/compose.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

/**
 * The invariant this file exists for: an address outside the configured
 * perimeter never reaches `run`, and never reaches a confirmation either.
 *
 * A refusal the user is first asked to confirm is not a perimeter, it is a
 * speed bump — so the check is asserted to happen before the question, and
 * before anything is written.
 */

const identityGet = loadFixture<GetResponse<Identity>>("identity-get.json");
const mailboxGet = loadFixture<GetResponse<Mailbox>>("mailbox-get.json");
const emailSetCreated = loadFixture<SetResponse<Email>>("email-set-created.json");
const submissionSet = loadFixture<SetResponse<EmailSubmission>>("email-submission-set.json");

const soleIdentity: GetResponse<Identity> = { ...identityGet, list: identityGet.list.slice(0, 1) };

/** camille is in the address books; the stranger is in nobody's. */
const KNOWN = "camille@example.org";
const STRANGER = "stranger@elsewhere.test";

const perimeter: RecipientScope = restrictTo({ fromContacts: [KNOWN], allow: [] });

const draftGet: GetResponse<Email> = {
  accountId: "acc-1",
  state: "email-state-2",
  list: [
    {
      id: "em-draft-1",
      mailboxIds: { "mb-drafts": true },
      from: [{ name: "Bryan Berger", email: "bryan@example.com" }],
      to: [{ name: null, email: STRANGER }],
      subject: "Réunion de lancement",
    } as unknown as Email,
  ],
  notFound: [],
};

/** A message from the stranger. Answering it names no address in the arguments. */
const strangerSource: GetResponse<Email> = {
  accountId: "acc-1",
  state: "email-state-2",
  list: [
    {
      id: "em-origin-1",
      messageId: ["<origin-1@example.org>"],
      references: null,
      subject: "Réunion de lancement",
      from: [{ name: null, email: STRANGER }],
      replyTo: null,
    } as unknown as Email,
  ],
  notFound: [],
};

const moved: SetResponse<Email> = {
  accountId: "acc-1",
  oldState: "email-state-2",
  newState: "email-state-3",
  updated: { "em-draft-1": null },
};

type Handler = (
  args: unknown,
  ctx: { mcpReq: { inputResponses?: Record<string, unknown>; envelope?: Record<string, unknown> } },
) => Promise<unknown>;

/** A confirmation already granted: it must not be enough to get past a refusal. */
const CONFIRMED = {
  mcpReq: { inputResponses: { confirm: { action: "accept", content: { confirm: true } } } },
};

function sendingSurface(responses: unknown[], recipients: RecipientScope) {
  const { context, requests } = fakeTransport(responses, recipients);
  const handlers = new Map<string, Handler>();

  compose({
    server: {
      registerTool(name: string, _config: unknown, cb: Handler) {
        handlers.set(name, cb);
      },
      server: { getClientCapabilities: () => ({ elicitation: {} }) },
    } as unknown as McpServer,
    domains: [mailSendingDomain],
    session: context.session,
    client: context.client,
    policy: DEFAULT_POLICY,
    recipients,
  });

  return { handlers, requests };
}

/** Every method a call emitted, whatever the round trip it travelled in. */
function methodsOf(requests: JmapRequest[]): string[] {
  return requests.flatMap((request) => request.methodCalls.map(([name]) => name));
}

function textOf(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((part) => part.text ?? "").join("");
}

describe("a recipient outside the perimeter", () => {
  it("is refused by mail_compose without writing anything", async () => {
    const { handlers, requests } = sendingSurface(
      [soleIdentity, mailboxGet, emailSetCreated],
      perimeter,
    );

    const result = await handlers.get("mail_compose")?.(
      { to: [STRANGER], subject: "Hi", body: "Text" },
      CONFIRMED,
    );

    expect(textOf(result)).toContain(STRANGER);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(methodsOf(requests)).toEqual([]);
  });

  it("is refused before the confirmation, not after it", async () => {
    const { handlers, requests } = sendingSurface(
      [soleIdentity, mailboxGet, emailSetCreated],
      perimeter,
    );

    // No confirmation granted: a tool that asked for one would answer with a
    // required-input result instead of the refusal.
    const result = await handlers.get("mail_compose")?.(
      { to: [STRANGER], body: "Text", send: true },
      { mcpReq: {} },
    );

    expect(isInputRequiredResult(result)).toBe(false);
    expect(textOf(result)).toContain("outside the recipient perimeter");
    expect(methodsOf(requests)).toEqual([]);
  });

  it("is refused on a reply that names no address, still before the confirmation", async () => {
    // The arguments carry no recipient at all: the only one is in the message
    // being answered, which is exactly the shape that used to slip through.
    const { handlers, requests } = sendingSurface(
      [soleIdentity, mailboxGet, strangerSource, emailSetCreated],
      perimeter,
    );

    const result = await handlers.get("mail_compose")?.(
      { replyToEmailId: "em-origin-1", body: "Text", send: true },
      { mcpReq: {} },
    );

    expect(isInputRequiredResult(result)).toBe(false);
    expect(textOf(result)).toContain(STRANGER);
    expect(methodsOf(requests)).not.toContain("Email/set");
    expect(methodsOf(requests)).not.toContain("EmailSubmission/set");
  });

  it("is refused by mail_send, which submits nothing", async () => {
    const { handlers, requests } = sendingSurface(
      [identityGet, mailboxGet, draftGet, submissionSet, moved],
      perimeter,
    );

    const result = await handlers.get("mail_send")?.({ emailId: "em-draft-1" }, CONFIRMED);

    expect(textOf(result)).toContain(STRANGER);
    expect(methodsOf(requests)).not.toContain("EmailSubmission/set");
  });

  it("cannot be reached by confirming twice, or by any argument", async () => {
    // Two attempts, so two reads of the draft: the queue answers both.
    const { handlers, requests } = sendingSurface(
      [identityGet, mailboxGet, draftGet, identityGet, mailboxGet, draftGet],
      perimeter,
    );

    for (const attempt of [
      { emailId: "em-draft-1" },
      { emailId: "em-draft-1", identityId: "id-1" },
    ]) {
      await handlers.get("mail_send")?.(attempt, CONFIRMED);
    }

    expect(methodsOf(requests)).not.toContain("EmailSubmission/set");
    expect(methodsOf(requests)).not.toContain("Email/set");
  });
});

describe("a perimeter that could not be read", () => {
  it("refuses every recipient, including one the address books hold", async () => {
    const unreadable: RecipientScope = { kind: "unreadable", reason: "JMAP request failed: 503" };
    const { handlers, requests } = sendingSurface(
      [soleIdentity, mailboxGet, emailSetCreated],
      unreadable,
    );

    const result = await handlers.get("mail_compose")?.({ to: [KNOWN], body: "Text" }, CONFIRMED);

    expect(textOf(result)).toContain("503");
    expect(methodsOf(requests)).toEqual([]);
  });
});

describe("a recipient inside the perimeter", () => {
  it("goes through, and the draft is written", async () => {
    const { handlers, requests } = sendingSurface(
      [soleIdentity, mailboxGet, emailSetCreated],
      perimeter,
    );

    const result = await handlers.get("mail_compose")?.(
      { to: [KNOWN], subject: "Hi", body: "Text" },
      { mcpReq: {} },
    );

    expect(textOf(result)).toContain("saved to drafts");
    expect(methodsOf(requests)).toContain("Email/set");
  });
});
