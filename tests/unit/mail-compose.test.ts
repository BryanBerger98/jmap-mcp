import { describe, expect, it } from "vitest";
import { mailCompose } from "../../src/domains/mail/compose.js";
import type { GetResponse, JmapRequest, SetResponse } from "../../src/jmap/types/core.js";
import type { Email, EmailSubmission, Identity, Mailbox } from "../../src/jmap/types/mail.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const identityGet = loadFixture<GetResponse<Identity>>("identity-get.json");
const mailboxGet = loadFixture<GetResponse<Mailbox>>("mailbox-get.json");
const emailSetCreated = loadFixture<SetResponse<Email>>("email-set-created.json");
const replySource = loadFixture<GetResponse<Email>>("email-reply-source.json");
const submissionSet = loadFixture<SetResponse<EmailSubmission>>("email-submission-set.json");

/** The implicit `Email/set` the server runs once the submission succeeds. */
const movedToSent: SetResponse<Email> = {
  accountId: "acc-1",
  oldState: "email-state-2",
  newState: "email-state-3",
  updated: { "em-draft-1": null },
};

/** The account the happy path uses: one identity, so none has to be designated. */
const soleIdentity: GetResponse<Identity> = {
  ...identityGet,
  list: identityGet.list.slice(0, 1),
};

/** The `create` payload of the `Email/set` the tool emitted. */
function draftSent(requests: JmapRequest[]): Record<string, unknown> | undefined {
  const set = requests
    .flatMap((request) => request.methodCalls)
    .find(([name]) => name === "Email/set");
  const create = set?.[1].create as Record<string, Record<string, unknown>> | undefined;
  return create?.draft;
}

/** The arguments of the `EmailSubmission/set` the tool emitted, if any. */
function submissionSent(requests: JmapRequest[]): Record<string, unknown> | undefined {
  return requests
    .flatMap((request) => request.methodCalls)
    .find(([name]) => name === "EmailSubmission/set")?.[1];
}

function submissionCreated(requests: JmapRequest[]): Record<string, unknown> | undefined {
  const create = submissionSent(requests)?.create as
    | Record<string, Record<string, unknown>>
    | undefined;
  return create?.submission;
}

describe("mail_compose", () => {
  it("classifies a call that does not send as a draft", () => {
    expect(mailCompose.classify({ to: ["a@b.c"], body: "x" })).toBe("draft");
    expect(mailCompose.classify({ replyToEmailId: "em-1", body: "x" })).toBe("draft");
  });

  it("resolves the identity and the folders before writing anything", async () => {
    const { context, requests } = fakeTransport([soleIdentity, mailboxGet, emailSetCreated]);

    await mailCompose.run({ to: ["camille@example.org"], subject: "Hi", body: "Text" }, context);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.methodCalls.map(([name]) => name)).toEqual(["Identity/get", "Mailbox/get"]);
    expect(requests[1]?.methodCalls.map(([name]) => name)).toEqual(["Email/set"]);
  });

  it("files the draft in the drafts folder with the $draft keyword", async () => {
    const { context, requests } = fakeTransport([soleIdentity, mailboxGet, emailSetCreated]);

    await mailCompose.run({ to: ["camille@example.org"], subject: "Hi", body: "Text" }, context);
    const draft = draftSent(requests);

    expect(draft?.mailboxIds).toEqual({ "mb-drafts": true });
    expect(draft?.keywords).toEqual({ $draft: true });
  });

  it("sends exactly one plain-text body part and no headers", async () => {
    const { context, requests } = fakeTransport([soleIdentity, mailboxGet, emailSetCreated]);

    await mailCompose.run({ to: ["camille@example.org"], body: "Bonjour" }, context);
    const draft = draftSent(requests);

    expect(draft?.textBody).toEqual([{ partId: "body", type: "text/plain" }]);
    expect(draft?.bodyValues).toEqual({ body: { value: "Bonjour" } });
    expect(draft).not.toHaveProperty("headers");
    expect(Object.keys(draft ?? {}).some((key) => key.startsWith("header:"))).toBe(false);
    // The server computes all three; naming them would fight it.
    expect(draft).not.toHaveProperty("charset");
    expect(draft).not.toHaveProperty("size");
  });

  it("takes the sender from the identity, never from the input", async () => {
    const { context, requests } = fakeTransport([soleIdentity, mailboxGet, emailSetCreated]);

    await mailCompose.run(
      { to: ["camille@example.org"], body: "Text", from: ["spoofed@example.net"] } as never,
      context,
    );

    expect(draftSent(requests)?.from).toEqual([
      { name: "Bryan Berger", email: "bryan@example.com" },
    ]);
  });

  it("returns the created draft id and says nothing was sent", async () => {
    const { context } = fakeTransport([soleIdentity, mailboxGet, emailSetCreated]);

    const { text } = await mailCompose.run(
      { to: ["camille@example.org"], subject: "Hi", body: "Text" },
      context,
    );

    expect(text).toContain("em-draft-1");
    expect(text).toContain("not sent");
  });

  describe("replying", () => {
    it("reads the origin message in the same round trip as the identity", async () => {
      const { context, requests } = fakeTransport([
        soleIdentity,
        mailboxGet,
        replySource,
        emailSetCreated,
      ]);

      await mailCompose.run({ replyToEmailId: "em-origin-1", body: "D'accord" }, context);

      expect(requests[0]?.methodCalls.map(([name]) => name)).toEqual([
        "Identity/get",
        "Mailbox/get",
        "Email/get",
      ]);
    });

    it("threads the reply onto the origin's message id", async () => {
      const { context, requests } = fakeTransport([
        soleIdentity,
        mailboxGet,
        replySource,
        emailSetCreated,
      ]);

      await mailCompose.run({ replyToEmailId: "em-origin-1", body: "D'accord" }, context);
      const draft = draftSent(requests);

      expect(draft?.inReplyTo).toEqual(["<origin-1@example.org>"]);
      expect(draft?.references).toEqual([
        "<root-0@example.org>",
        "<middle-1@example.org>",
        "<origin-1@example.org>",
      ]);
    });

    it("prefixes the subject with Re: once", async () => {
      const { context, requests } = fakeTransport([
        soleIdentity,
        mailboxGet,
        replySource,
        emailSetCreated,
      ]);

      await mailCompose.run({ replyToEmailId: "em-origin-1", body: "D'accord" }, context);

      expect(draftSent(requests)?.subject).toBe("Re: Réunion de lancement");
    });

    it("adds no second prefix to an already prefixed subject, whatever its casing", async () => {
      const prefixed: GetResponse<Email> = {
        ...replySource,
        list: [{ ...(replySource.list[0] as Email), subject: "RE: Réunion de lancement" }],
      };
      const { context, requests } = fakeTransport([
        soleIdentity,
        mailboxGet,
        prefixed,
        emailSetCreated,
      ]);

      await mailCompose.run({ replyToEmailId: "em-origin-1", body: "D'accord" }, context);

      expect(draftSent(requests)?.subject).toBe("RE: Réunion de lancement");
    });

    it("answers the Reply-To address rather than the From when both exist", async () => {
      const { context, requests } = fakeTransport([
        soleIdentity,
        mailboxGet,
        replySource,
        emailSetCreated,
      ]);

      await mailCompose.run({ replyToEmailId: "em-origin-1", body: "D'accord" }, context);

      expect(draftSent(requests)?.to).toEqual([
        { name: null, email: "camille+replies@example.org" },
      ]);
    });

    it("falls back to the From when the origin declares no Reply-To", async () => {
      const noReplyTo: GetResponse<Email> = {
        ...replySource,
        list: [{ ...(replySource.list[0] as Email), replyTo: null }],
      };
      const { context, requests } = fakeTransport([
        soleIdentity,
        mailboxGet,
        noReplyTo,
        emailSetCreated,
      ]);

      await mailCompose.run({ replyToEmailId: "em-origin-1", body: "D'accord" }, context);

      expect(draftSent(requests)?.to).toEqual([{ name: null, email: "camille@example.org" }]);
    });

    it("never updates the origin message", async () => {
      const { context, requests } = fakeTransport([
        soleIdentity,
        mailboxGet,
        replySource,
        emailSetCreated,
      ]);

      await mailCompose.run({ replyToEmailId: "em-origin-1", body: "D'accord" }, context);

      const emitted = requests.flatMap((request) => request.methodCalls);
      expect(emitted.filter(([name]) => name === "Email/set")).toHaveLength(1);
      expect(draftSent(requests)).toBeDefined();
      const set = emitted.find(([name]) => name === "Email/set");
      expect(set?.[1]).not.toHaveProperty("update");
      expect(set?.[1]).not.toHaveProperty("destroy");
    });
  });

  describe("refusals", () => {
    it("refuses an identity that is not in the account, before writing", async () => {
      const { context, requests } = fakeTransport([identityGet, mailboxGet]);

      const { text } = await mailCompose.run(
        { to: ["a@b.co"], body: "Text", identityId: "id-elsewhere" },
        context,
      );

      expect(text).toContain("id-elsewhere");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.methodCalls.some(([name]) => name === "Email/set")).toBe(false);
    });

    it("refuses to pick a sender when the account has several identities", async () => {
      const { context, requests } = fakeTransport([identityGet, mailboxGet]);

      const { text } = await mailCompose.run({ to: ["a@b.co"], body: "Text" }, context);

      expect(text).toContain("identityId");
      expect(requests).toHaveLength(1);
    });

    it("refuses when no folder carries the drafts role", async () => {
      const noDrafts: GetResponse<Mailbox> = {
        ...mailboxGet,
        list: mailboxGet.list.filter((mailbox) => mailbox.role !== "drafts"),
      };
      const { context, requests } = fakeTransport([soleIdentity, noDrafts]);

      const { text } = await mailCompose.run({ to: ["a@b.co"], body: "Text" }, context);

      expect(text).toContain("`drafts` role");
      expect(requests).toHaveLength(1);
    });

    it("quotes the server's own error when the draft is not created", async () => {
      const rejected: SetResponse<Email> = {
        accountId: "acc-1",
        oldState: "email-state-1",
        newState: "email-state-1",
        notCreated: {
          draft: { type: "overQuota", description: "Mailbox is full", properties: ["size"] },
        },
      };
      const { context } = fakeTransport([soleIdentity, mailboxGet, rejected]);

      const { text } = await mailCompose.run({ to: ["a@b.co"], body: "Text" }, context);

      expect(text).toContain("overQuota");
      expect(text).toContain("Mailbox is full");
    });
  });

  describe("sending in one go", () => {
    it("becomes a send as soon as the argument says so", () => {
      expect(mailCompose.classes).toEqual(["draft", "send"]);
      expect(mailCompose.classify({ to: ["a@b.c"], body: "x", send: true })).toBe("send");
      expect(mailCompose.classify({ to: ["a@b.c"], body: "x", send: false })).toBe("draft");
    });

    it("says it is sending in the line shown at confirmation time", async () => {
      const { context } = fakeTransport([]);
      const input = { to: ["camille@example.org"], subject: "Hi", body: "Text", send: true };

      const summary = await mailCompose.summarize(input, context);

      expect(summary).toContain("Send a message");
      expect(summary).toContain("camille@example.org");
      expect(summary).toContain("Hi");
      expect(await mailCompose.summarize({ ...input, send: false }, context)).toContain(
        "Save a draft",
      );
    });

    it("names the address a reply leaves for, rather than the message it answers", async () => {
      const { context } = fakeTransport([soleIdentity, mailboxGet, replySource]);

      const summary = await mailCompose.summarize(
        { replyToEmailId: "em-origin-1", body: "D'accord", send: true },
        context,
      );

      expect(summary).toContain("camille+replies@example.org");
      expect(summary).not.toContain("the sender of the message answered");
    });

    it("falls back to a generic line when the message answered cannot be read", async () => {
      const gone: GetResponse<Email> = {
        accountId: "acc-1",
        state: "email-state-2",
        list: [],
        notFound: ["em-origin-1"],
      };
      const { context } = fakeTransport([soleIdentity, mailboxGet, gone]);

      const summary = await mailCompose.summarize(
        { replyToEmailId: "em-origin-1", body: "D'accord", send: true },
        context,
      );

      expect(summary).toContain("the sender of the message answered");
    });

    it("creates and submits in a single request, pointing at the draft by creation id", async () => {
      const { context, requests } = fakeTransport([
        soleIdentity,
        mailboxGet,
        emailSetCreated,
        submissionSet,
        movedToSent,
      ]);

      await mailCompose.run(
        { to: ["camille@example.org"], subject: "Hi", body: "Text", send: true },
        context,
      );

      expect(requests).toHaveLength(2);
      expect(requests[1]?.methodCalls.map(([name]) => name)).toEqual([
        "Email/set",
        "EmailSubmission/set",
      ]);
      expect(submissionCreated(requests)?.emailId).toBe("#draft");
    });

    it("carries the same envelope and the same move as sending in two gestures", async () => {
      const { context, requests } = fakeTransport([
        soleIdentity,
        mailboxGet,
        emailSetCreated,
        submissionSet,
        movedToSent,
      ]);

      await mailCompose.run(
        { to: ["camille@example.org"], cc: ["ana@example.org"], body: "Text", send: true },
        context,
      );

      expect(submissionCreated(requests)?.envelope).toEqual({
        mailFrom: { email: "bryan@example.com" },
        rcptTo: [{ email: "camille@example.org" }, { email: "ana@example.org" }],
      });
      expect(submissionSent(requests)?.onSuccessUpdateEmail).toEqual({
        "#submission": {
          "mailboxIds/mb-drafts": null,
          "mailboxIds/mb-sent": true,
          "keywords/$draft": null,
        },
      });
    });

    it("reports the submission rather than a saved draft", async () => {
      const { context } = fakeTransport([
        soleIdentity,
        mailboxGet,
        emailSetCreated,
        submissionSet,
        movedToSent,
      ]);

      const { text } = await mailCompose.run(
        { to: ["camille@example.org"], subject: "Hi", body: "Text", send: true },
        context,
      );

      expect(text).toContain("sub-1");
      expect(text).toContain("moved to the sent folder");
      expect(text).not.toContain("not sent");
    });

    it("refuses before writing when no folder carries the sent role", async () => {
      const noSent: GetResponse<Mailbox> = {
        ...mailboxGet,
        list: mailboxGet.list.filter((mailbox) => mailbox.role !== "sent"),
      };
      const { context, requests } = fakeTransport([soleIdentity, noSent]);

      const { text } = await mailCompose.run(
        { to: ["camille@example.org"], body: "Text", send: true },
        context,
      );

      expect(text).toContain("`sent` role");
      expect(requests).toHaveLength(1);
    });

    it("reports a submission the server refused, and never claims it was sent", async () => {
      const refused: SetResponse<EmailSubmission> = {
        accountId: "acc-1",
        oldState: "submission-state-1",
        newState: "submission-state-1",
        notCreated: { submission: { type: "tooManyRecipients" } },
      };
      const { context } = fakeTransport([soleIdentity, mailboxGet, emailSetCreated, refused]);

      const { text } = await mailCompose.run(
        { to: ["camille@example.org"], body: "Text", send: true },
        context,
      );

      expect(text).toContain("tooManyRecipients");
      expect(text).toContain("more recipients than the server accepts");
      expect(text).not.toContain("moved to the sent folder");
    });
  });

  describe("input schema", () => {
    it("requires a recipient unless a message is being answered", () => {
      expect(mailCompose.inputSchema.safeParse({ body: "Text" }).success).toBe(false);
      expect(
        mailCompose.inputSchema.safeParse({ body: "Text", replyToEmailId: "em-1" }).success,
      ).toBe(true);
    });

    it("refuses an empty recipient list", () => {
      expect(mailCompose.inputSchema.safeParse({ to: [], body: "Text" }).success).toBe(false);
    });
  });
});
