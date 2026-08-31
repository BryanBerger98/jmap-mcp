import { describe, expect, it } from "vitest";
import { mailSend } from "../../src/domains/mail/send.js";
import type { GetResponse, Id, JmapRequest, SetResponse } from "../../src/jmap/types/core.js";
import type { Email, EmailSubmission, Identity, Mailbox } from "../../src/jmap/types/mail.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const identityGet = loadFixture<GetResponse<Identity>>("identity-get.json");
const mailboxGet = loadFixture<GetResponse<Mailbox>>("mailbox-get.json");
const submissionSet = loadFixture<SetResponse<EmailSubmission>>("email-submission-set.json");

/** The implicit `Email/set` the server runs on `onSuccessUpdateEmail`. */
const moved: SetResponse<Email> = {
  accountId: "acc-1",
  oldState: "email-state-2",
  newState: "email-state-3",
  updated: { "em-draft-1": null },
};

/** A draft sitting in the drafts folder, addressed to two people. */
function draftIn(mailboxIds: Record<Id, boolean>, overrides: Partial<Email> = {}) {
  const email = {
    id: "em-draft-1",
    mailboxIds,
    from: [{ name: "Bryan Berger", email: "bryan@example.com" }],
    to: [{ name: null, email: "camille@example.org" }],
    cc: [{ name: null, email: "ana@example.org" }],
    subject: "Réunion de lancement",
    ...overrides,
  } as unknown as Email;

  return {
    accountId: "acc-1",
    state: "email-state-2",
    list: [email],
    notFound: [],
  } satisfies GetResponse<Email>;
}

const draft = draftIn({ "mb-drafts": true });

/** The arguments of the `EmailSubmission/set` the tool emitted, if any. */
function submissionSent(requests: JmapRequest[]): Record<string, unknown> | undefined {
  return requests
    .flatMap((request) => request.methodCalls)
    .find(([name]) => name === "EmailSubmission/set")?.[1];
}

function createdSubmission(requests: JmapRequest[]): Record<string, unknown> | undefined {
  const create = submissionSent(requests)?.create as
    | Record<string, Record<string, unknown>>
    | undefined;
  return create?.submission;
}

describe("mail_send", () => {
  it("is a send whatever its arguments", () => {
    expect(mailSend.classes).toEqual(["send"]);
    expect(mailSend.classify({ emailId: "em-draft-1" })).toBe("send");
    expect(mailSend.classify({ emailId: "em-draft-1", identityId: "id-2" })).toBe("send");
  });

  it("reads the identity, the folders and the message before submitting", async () => {
    const { context, requests } = fakeTransport([identityGet, mailboxGet, draft, submissionSet]);

    await mailSend.run({ emailId: "em-draft-1" }, context);

    expect(requests[0]?.methodCalls.map(([name]) => name)).toEqual([
      "Identity/get",
      "Mailbox/get",
      "Email/get",
    ]);
    expect(requests[1]?.methodCalls.map(([name]) => name)).toEqual(["EmailSubmission/set"]);
  });

  it("states the envelope rather than letting the server derive it", async () => {
    const { context, requests } = fakeTransport([
      identityGet,
      mailboxGet,
      draft,
      submissionSet,
      moved,
    ]);

    await mailSend.run({ emailId: "em-draft-1" }, context);

    expect(createdSubmission(requests)?.envelope).toEqual({
      mailFrom: { email: "bryan@example.com" },
      rcptTo: [{ email: "camille@example.org" }, { email: "ana@example.org" }],
    });
  });

  it("covers to, cc and bcc in rcptTo, without repeating an address", async () => {
    const withBcc = draftIn(
      { "mb-drafts": true },
      {
        // camille is named twice: one recipient, one delivery.
        bcc: [
          { name: null, email: "camille@example.org" },
          { name: null, email: "hidden@example.net" },
        ],
      },
    );
    const { context, requests } = fakeTransport([
      identityGet,
      mailboxGet,
      withBcc,
      submissionSet,
      moved,
    ]);

    await mailSend.run({ emailId: "em-draft-1" }, context);
    const envelope = createdSubmission(requests)?.envelope as { rcptTo: { email: string }[] };

    expect(envelope.rcptTo.map((address) => address.email)).toEqual([
      "camille@example.org",
      "ana@example.org",
      "hidden@example.net",
    ]);
  });

  it("leaves sendAt and undoStatus to the server", async () => {
    const { context, requests } = fakeTransport([
      identityGet,
      mailboxGet,
      draft,
      submissionSet,
      moved,
    ]);

    await mailSend.run({ emailId: "em-draft-1" }, context);
    const submission = createdSubmission(requests);

    expect(submission).not.toHaveProperty("sendAt");
    expect(submission).not.toHaveProperty("undoStatus");
    expect(Object.keys(submission ?? {})).toEqual(["identityId", "emailId", "envelope"]);
  });

  it("moves the message out of drafts and into sent, clearing $draft", async () => {
    const { context, requests } = fakeTransport([
      identityGet,
      mailboxGet,
      draft,
      submissionSet,
      moved,
    ]);

    await mailSend.run({ emailId: "em-draft-1" }, context);

    expect(submissionSent(requests)?.onSuccessUpdateEmail).toEqual({
      "#submission": {
        "mailboxIds/mb-drafts": null,
        "mailboxIds/mb-sent": true,
        "keywords/$draft": null,
      },
    });
  });

  it("reports the submission, its recipients and where the message ended up", async () => {
    const { context } = fakeTransport([identityGet, mailboxGet, draft, submissionSet, moved]);

    const { text } = await mailSend.run({ emailId: "em-draft-1" }, context);

    expect(text).toContain("sub-1");
    expect(text).toContain("camille@example.org, ana@example.org");
    expect(text).toContain("Réunion de lancement");
    expect(text).toContain("moved to the sent folder");
  });

  it("says so when the message went out but could not be moved", async () => {
    const stuck: SetResponse<Email> = {
      accountId: "acc-1",
      oldState: "email-state-2",
      newState: "email-state-2",
      notUpdated: { "em-draft-1": { type: "forbidden" } },
    };
    const { context } = fakeTransport([identityGet, mailboxGet, draft, submissionSet, stuck]);

    const { text } = await mailSend.run({ emailId: "em-draft-1" }, context);

    expect(text).toContain("sent, but it could not be moved out of drafts");
    expect(text).toContain("forbidden");
  });

  describe("choosing the sender", () => {
    it("takes the identity whose address the draft already carries", async () => {
      const { context, requests } = fakeTransport([
        identityGet,
        mailboxGet,
        draft,
        submissionSet,
        moved,
      ]);

      await mailSend.run({ emailId: "em-draft-1" }, context);

      // Two identities exist; the draft's own From settles which one sends.
      expect(createdSubmission(requests)?.identityId).toBe("id-1");
    });

    it("obeys an identityId given explicitly", async () => {
      const { context, requests } = fakeTransport([
        identityGet,
        mailboxGet,
        draft,
        submissionSet,
        moved,
      ]);

      await mailSend.run({ emailId: "em-draft-1", identityId: "id-2" }, context);

      expect(createdSubmission(requests)?.identityId).toBe("id-2");
    });

    it("refuses when the draft's sender matches none of the identities", async () => {
      const foreign = draftIn(
        { "mb-drafts": true },
        { from: [{ name: null, email: "someone@elsewhere.test" }] },
      );
      const { context, requests } = fakeTransport([identityGet, mailboxGet, foreign]);

      const { text } = await mailSend.run({ emailId: "em-draft-1" }, context);

      expect(text).toContain("identityId");
      expect(requests).toHaveLength(1);
    });
  });

  describe("refusals", () => {
    it("refuses a message that is not in the drafts folder, naming where it is", async () => {
      const received = draftIn({ "mb-inbox": true });
      const { context, requests } = fakeTransport([identityGet, mailboxGet, received]);

      const { text } = await mailSend.run({ emailId: "em-draft-1" }, context);

      expect(text).toContain("not in the drafts folder");
      expect(text).toContain("Inbox");
      expect(requests).toHaveLength(1);
      expect(submissionSent(requests)).toBeUndefined();
    });

    it("refuses a message the account does not hold", async () => {
      const nothing: GetResponse<Email> = {
        accountId: "acc-1",
        state: "email-state-2",
        list: [],
        notFound: ["em-gone"],
      };
      const { context, requests } = fakeTransport([identityGet, mailboxGet, nothing]);

      const { text } = await mailSend.run({ emailId: "em-gone" }, context);

      expect(text).toContain("em-gone");
      expect(requests).toHaveLength(1);
    });

    it("refuses before submitting when no folder carries the sent role", async () => {
      const noSent: GetResponse<Mailbox> = {
        ...mailboxGet,
        list: mailboxGet.list.filter((mailbox) => mailbox.role !== "sent"),
      };
      const { context, requests } = fakeTransport([identityGet, noSent, draft]);

      const { text } = await mailSend.run({ emailId: "em-draft-1" }, context);

      expect(text).toContain("`sent` role");
      expect(requests).toHaveLength(1);
    });

    it("refuses a draft with no recipient at all", async () => {
      const empty = draftIn({ "mb-drafts": true }, { to: null, cc: null });
      const { context, requests } = fakeTransport([identityGet, mailboxGet, empty]);

      const { text } = await mailSend.run({ emailId: "em-draft-1" }, context);

      expect(text).toContain("no recipient");
      expect(requests).toHaveLength(1);
    });

    it("quotes and glosses a submission the server refused", async () => {
      const refused: SetResponse<EmailSubmission> = {
        accountId: "acc-1",
        oldState: "submission-state-1",
        newState: "submission-state-1",
        notCreated: {
          submission: {
            type: "forbiddenFrom",
            description: "Identity id-1 may not send as bryan@example.com",
          },
        },
      };
      const { context } = fakeTransport([identityGet, mailboxGet, draft, refused, moved]);

      const { text } = await mailSend.run({ emailId: "em-draft-1" }, context);

      expect(text).toContain("forbiddenFrom");
      expect(text).toContain("may not send from that address");
    });
  });

  describe("the confirmation it asks for", () => {
    it("names the sender, the recipients and the subject", async () => {
      const { context } = fakeTransport([identityGet, mailboxGet, draft]);

      const summary = await mailSend.summarize({ emailId: "em-draft-1" }, context);

      expect(summary).toContain("bryan@example.com");
      expect(summary).toContain("camille@example.org");
      expect(summary).toContain("ana@example.org");
      expect(summary).toContain("Réunion de lancement");
    });

    it("sends nothing while summarizing", async () => {
      const { context, requests } = fakeTransport([identityGet, mailboxGet, draft]);

      await mailSend.summarize({ emailId: "em-draft-1" }, context);

      expect(submissionSent(requests)).toBeUndefined();
    });

    it("announces the refusal instead of a send it will not do", async () => {
      const received = draftIn({ "mb-inbox": true });
      const { context } = fakeTransport([identityGet, mailboxGet, received]);

      const summary = await mailSend.summarize({ emailId: "em-draft-1" }, context);

      expect(summary).toContain("Nothing will be sent");
    });
  });
});
