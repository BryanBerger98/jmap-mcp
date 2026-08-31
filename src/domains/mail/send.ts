import { z } from "zod";
import type { GetResponse, Id, Invocation, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION } from "../../jmap/types/core.js";
import type {
  Email,
  EmailGetArguments,
  EmailSubmission,
  Identity,
  IdentityGetArguments,
  Mailbox,
  MailboxGetArguments,
} from "../../jmap/types/mail.js";
import { defineTool } from "../../registry/define-tool.js";
import {
  buildSubmission,
  describeSubmission,
  MISSING_SENT_FOLDER,
  pickIdentity,
  uniqueRecipients,
} from "./compose.js";

/** Only what the envelope, the summary and the drafts check read. */
const MESSAGE_PROPERTIES = ["id", "mailboxIds", "from", "to", "cc", "bcc", "subject"];

const IDENTITY_PROPERTIES = ["id", "name", "email"];

const MAILBOX_PROPERTIES = ["id", "name", "role"];

const inputSchema = z.object({
  emailId: z
    .string()
    .describe("The draft to send, as returned by mail_compose. It must sit in the drafts folder."),
  identityId: z
    .string()
    .optional()
    .describe(
      "Sender identity, as listed by mail_identities. Defaults to the one matching the draft's " +
        "own From address.",
    ),
});

export const mailSend = defineTool({
  name: "mail_send",
  title: "Send a draft",
  description:
    "Sends a draft that already exists, and moves it to the sent folder. It composes nothing: " +
    "write the message with mail_compose first, read it back, then send it by id. " +
    "A message that is not in the drafts folder is refused rather than sent a second time. " +
    "This cannot be undone once confirmed.",
  inputSchema,
  classes: ["send"],
  classify: () => "send",
  summarize: async (input, { client, session }) => {
    // The confirmation is worth reading only if it names what leaves the
    // account, and the arguments carry an id alone.
    const resolved = await resolveSend(input, client, session).catch(() => undefined);

    if (resolved === undefined) {
      return `Send message ${input.emailId}. Its recipients could not be read from the server.`;
    }
    if ("refusal" in resolved) {
      return `Nothing will be sent: ${resolved.refusal}`;
    }

    const { identity, email } = resolved;
    const recipients = uniqueRecipients(email);
    const subject = email.subject === null || email.subject === "" ? "(no subject)" : email.subject;

    return `Send "${subject}" from ${identity.email} to ${recipients.join(", ")}.`;
  },
  run: async (input, { client, session }) => {
    const resolved = await resolveSend(input, client, session);
    if ("refusal" in resolved) return { text: resolved.refusal };

    const { identity, email, draftsId, sentId } = resolved;
    const recipients = uniqueRecipients(email);
    if (recipients.length === 0) {
      return {
        text: `Refused: message ${email.id} carries no recipient, so there is nobody to send it to.`,
      };
    }

    const submission = buildSubmission({
      accountId: session.accountId,
      identityId: identity.id,
      mailFrom: identity.email,
      emailId: email.id,
      recipients,
      draftsId,
      sentId,
    });

    // `onSuccessUpdateEmail` makes the server run an implicit `Email/set`, whose
    // response follows the submission's own (RFC 8621 §7.5).
    const [submitted, moved] = await client.requestMany<
      [SetResponse<EmailSubmission>, SetResponse<Email> | undefined]
    >(
      [CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION],
      [["EmailSubmission/set", submission, "0"]],
    );

    return {
      text: describeSubmission(submitted, moved, {
        from: identity.email,
        recipients,
        subject: email.subject ?? "",
      }),
    };
  },
});

interface SendContext {
  identity: Identity;
  email: Email;
  draftsId: Id;
  sentId: Id;
}

/**
 * Resolves the identity, both folders and the message, in one round trip.
 *
 * Every refusal happens here, before anything is submitted: a message that is
 * already out cannot be called back, so a doubt has to be raised while the
 * account is still untouched.
 */
export async function resolveSend(
  input: { emailId: string; identityId?: string | undefined },
  client: {
    requestMany: <T extends unknown[]>(using: string[], calls: Invocation[]) => Promise<T>;
  },
  session: { accountId: Id },
): Promise<SendContext | { refusal: string }> {
  const identityArguments: IdentityGetArguments = {
    accountId: session.accountId,
    ids: null,
    properties: IDENTITY_PROPERTIES,
  };
  const mailboxArguments: MailboxGetArguments = {
    accountId: session.accountId,
    ids: null,
    properties: MAILBOX_PROPERTIES,
  };
  const emailArguments: EmailGetArguments = {
    accountId: session.accountId,
    ids: [input.emailId],
    properties: MESSAGE_PROPERTIES,
  };

  const calls: Invocation[] = [
    ["Identity/get", identityArguments, "0"],
    ["Mailbox/get", mailboxArguments, "1"],
    ["Email/get", emailArguments, "2"],
  ];

  const [identities, mailboxes, emails] = await client.requestMany<
    [GetResponse<Identity>, GetResponse<Mailbox>, GetResponse<Email>]
  >([CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION], calls);

  const drafts = mailboxes.list.find((mailbox) => mailbox.role === "drafts");
  if (drafts === undefined) {
    return {
      refusal:
        "Refused: this account has no folder with the `drafts` role, so no message here can be " +
        "identified as a draft ready to send.",
    };
  }

  const sent = mailboxes.list.find((mailbox) => mailbox.role === "sent");
  if (sent === undefined) return { refusal: MISSING_SENT_FOLDER };

  const email = emails.list[0];
  if (email === undefined) {
    return {
      refusal: `Refused: message ${input.emailId} is not in this account, so there is nothing to send.`,
    };
  }

  const located = foldersOf(email);
  if (!located.includes(drafts.id)) {
    return { refusal: notADraft(input.emailId, located, mailboxes.list) };
  }

  const identity = identityFor(identities.list, email, input.identityId);
  if ("refusal" in identity) return identity;

  return { identity, email, draftsId: drafts.id, sentId: sent.id };
}

/**
 * Picks the sender.
 *
 * The draft already carries a From, so an identity matching it is the account
 * owner's own earlier answer to the question rather than a guess. Only when
 * nothing matches does the ambiguity go back to them.
 */
function identityFor(
  identities: Identity[],
  email: Email,
  requested: string | undefined,
): Identity | { refusal: string } {
  if (requested !== undefined) return pickIdentity(identities, requested);

  const from = email.from?.[0]?.email.toLowerCase();
  const match =
    from === undefined
      ? undefined
      : identities.find((identity) => identity.email.toLowerCase() === from);

  return match ?? pickIdentity(identities, undefined);
}

/** The folders a message is filed in. A message may sit in several at once. */
function foldersOf(email: Email): Id[] {
  return Object.entries(email.mailboxIds ?? {})
    .filter(([, isIn]) => isIn)
    .map(([id]) => id);
}

function notADraft(emailId: string, located: Id[], mailboxes: Mailbox[]): string {
  const names = located.map(
    (id) => mailboxes.find((mailbox) => mailbox.id === id)?.name ?? `folder ${id}`,
  );
  const where = names.length === 0 ? "no folder at all" : names.join(", ");

  return (
    `Refused: message ${emailId} is not in the drafts folder — it is in ${where}. ` +
    "mail_send only sends drafts, so a message that was already received or already sent is " +
    "never sent again."
  );
}
