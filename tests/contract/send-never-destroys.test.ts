import type { McpServer } from "@modelcontextprotocol/server";
import { isInputRequiredResult } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { mailSendingDomain } from "../../src/domains/mail/index.js";
import type { GetResponse, Id, JmapRequest, SetResponse } from "../../src/jmap/types/core.js";
import type { Email, EmailSubmission, Identity, Mailbox } from "../../src/jmap/types/mail.js";
import { compose } from "../../src/registry/compose.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

/**
 * The invariant this file exists for: sending moves a message, it never
 * destroys one. `onSuccessDestroyEmail` would delete the draft the moment the
 * submission succeeds, leaving no record of what left the account — and no way
 * to tell a message that was never sent from one that was.
 *
 * Both ways of sending are covered, because the argument that turns
 * `mail_compose` into a send bypasses `mail_send` entirely.
 */

const identityGet = loadFixture<GetResponse<Identity>>("identity-get.json");
const mailboxGet = loadFixture<GetResponse<Mailbox>>("mailbox-get.json");
const submissionSet = loadFixture<SetResponse<EmailSubmission>>("email-submission-set.json");
const emailSetCreated = loadFixture<SetResponse<Email>>("email-set-created.json");

const soleIdentity: GetResponse<Identity> = {
  ...identityGet,
  list: identityGet.list.slice(0, 1),
};

const draftGet: GetResponse<Email> = {
  accountId: "acc-1",
  state: "email-state-2",
  list: [
    {
      id: "em-draft-1",
      mailboxIds: { "mb-drafts": true },
      from: [{ name: "Bryan Berger", email: "bryan@example.com" }],
      to: [{ name: null, email: "camille@example.org" }],
      subject: "Réunion de lancement",
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

/** A confirmation already granted, so the call reaches the JMAP transport. */
const CONFIRMED = {
  mcpReq: { inputResponses: { confirm: { action: "accept", content: { confirm: true } } } },
};

/** The whole sending surface, registered exactly as the server registers it. */
function sendingSurface(responses: unknown[]) {
  const { context, requests } = fakeTransport(responses);
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
  });

  return { handlers, requests };
}

/** Every argument object the request carried, whatever the method. */
function everyArgument(requests: JmapRequest[]): Record<string, unknown>[] {
  return requests.flatMap((request) => request.methodCalls.map(([, args]) => args));
}

function submissionOf(requests: JmapRequest[]): Record<string, unknown> | undefined {
  return requests
    .flatMap((request) => request.methodCalls)
    .find(([name]) => name === "EmailSubmission/set")?.[1];
}

describe("sending never destroys", () => {
  it("moves the draft rather than destroying it, when sending by id", async () => {
    const { handlers, requests } = sendingSurface([
      identityGet,
      mailboxGet,
      draftGet,
      submissionSet,
      moved,
    ]);

    await handlers.get("mail_send")?.({ emailId: "em-draft-1" }, CONFIRMED);

    const submission = submissionOf(requests);
    expect(submission).toBeDefined();
    expect(submission).not.toHaveProperty("onSuccessDestroyEmail");
    expect(submission?.onSuccessUpdateEmail).toBeDefined();
  });

  it("moves the draft rather than destroying it, when composing and sending at once", async () => {
    const { handlers, requests } = sendingSurface([
      soleIdentity,
      mailboxGet,
      emailSetCreated,
      submissionSet,
      moved,
    ]);

    await handlers.get("mail_compose")?.(
      { to: ["camille@example.org"], subject: "Hi", body: "Text", send: true },
      CONFIRMED,
    );

    const submission = submissionOf(requests);
    expect(submission).toBeDefined();
    expect(submission).not.toHaveProperty("onSuccessDestroyEmail");
    expect(submission?.onSuccessUpdateEmail).toBeDefined();
  });

  it("emits no destroy of any kind on either path", async () => {
    const byId = sendingSurface([identityGet, mailboxGet, draftGet, submissionSet, moved]);
    await byId.handlers.get("mail_send")?.({ emailId: "em-draft-1" }, CONFIRMED);

    const inOneGo = sendingSurface([
      soleIdentity,
      mailboxGet,
      emailSetCreated,
      submissionSet,
      moved,
    ]);
    await inOneGo.handlers.get("mail_compose")?.(
      { to: ["camille@example.org"], body: "Text", send: true },
      CONFIRMED,
    );

    for (const args of [...everyArgument(byId.requests), ...everyArgument(inOneGo.requests)]) {
      expect(args).not.toHaveProperty("onSuccessDestroyEmail");
      expect(args).not.toHaveProperty("destroy");
    }
  });

  it("asks for one confirmation before either path touches the server", async () => {
    const byId = sendingSurface([identityGet, mailboxGet, draftGet, submissionSet, moved]);
    const first = await byId.handlers.get("mail_send")?.({ emailId: "em-draft-1" }, { mcpReq: {} });

    expect(isInputRequiredResult(first)).toBe(true);
    expect(submissionOf(byId.requests)).toBeUndefined();

    const inOneGo = sendingSurface([soleIdentity, mailboxGet, emailSetCreated, submissionSet]);
    const second = await inOneGo.handlers.get("mail_compose")?.(
      { to: ["camille@example.org"], body: "Text", send: true },
      { mcpReq: {} },
    );

    expect(isInputRequiredResult(second)).toBe(true);
    // Not even the draft is written: one refusal, and nothing was started.
    expect(inOneGo.requests.flatMap((request) => request.methodCalls)).toEqual([]);
  });

  it("leaves the draft alone when the confirmation is declined", async () => {
    const { handlers, requests } = sendingSurface([
      identityGet,
      mailboxGet,
      draftGet,
      submissionSet,
      moved,
    ]);

    await handlers.get("mail_send")?.(
      { emailId: "em-draft-1" },
      { mcpReq: { inputResponses: { confirm: { action: "decline" } } } },
    );

    expect(submissionOf(requests)).toBeUndefined();
  });

  it("writes a draft with no confirmation at all when nothing is being sent", async () => {
    const { handlers, requests } = sendingSurface([soleIdentity, mailboxGet, emailSetCreated]);

    const result = await handlers.get("mail_compose")?.(
      { to: ["camille@example.org"], body: "Text" },
      { mcpReq: {} },
    );

    expect(isInputRequiredResult(result)).toBe(false);
    expect(submissionOf(requests)).toBeUndefined();
    expect(requests[1]?.methodCalls.map(([name]: [string, ...unknown[]]) => name)).toEqual([
      "Email/set",
    ]);
  });
});

/** The move itself, checked once: it is what stands in for the destroy. */
describe("the move that replaces the destroy", () => {
  it("clears the draft folder and the $draft keyword", async () => {
    const { handlers, requests } = sendingSurface([
      identityGet,
      mailboxGet,
      draftGet,
      submissionSet,
      moved,
    ]);

    await handlers.get("mail_send")?.({ emailId: "em-draft-1" }, CONFIRMED);
    const patch = submissionOf(requests)?.onSuccessUpdateEmail as Record<
      Id,
      Record<string, unknown>
    >;

    expect(patch["#submission"]).toEqual({
      "mailboxIds/mb-drafts": null,
      "mailboxIds/mb-sent": true,
      "keywords/$draft": null,
    });
  });
});
