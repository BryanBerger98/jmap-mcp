import { z } from "zod";
import { checkRecipients, type RecipientScope } from "../../config/recipients.js";
import { explainSetError } from "../../jmap/errors.js";
import type { GetResponse, Id, Invocation, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION } from "../../jmap/types/core.js";
import type {
  Email,
  EmailAddress,
  EmailCreate,
  EmailGetArguments,
  EmailSetArguments,
  EmailSubmission,
  EmailSubmissionSetArguments,
  Envelope,
  Identity,
  IdentityGetArguments,
  Mailbox,
  MailboxGetArguments,
} from "../../jmap/types/mail.js";
import { defineTool } from "../../registry/define-tool.js";
import { renderFields } from "../../shared/render.js";

/**
 * The creation id the draft is filed under.
 *
 * Stable rather than generated: one draft is created per call, and a fixed id is
 * what a later call in the same request points at with `#draft`.
 */
export const DRAFT_CREATION_ID = "draft";

/** The single body part. One part, plain text: creation refuses `headers`. */
const BODY_PART_ID = "body";

/** Only what the threading and the fallback recipient need off the origin. */
const REPLY_SOURCE_PROPERTIES = ["id", "messageId", "references", "subject", "from", "replyTo"];

const IDENTITY_PROPERTIES = ["id", "name", "email"];

const MAILBOX_PROPERTIES = ["id", "name", "role"];

export const composeInputShape = {
  to: z
    .array(z.email())
    .min(1)
    .optional()
    .describe("Recipient addresses. Required unless replyToEmailId is given."),
  cc: z.array(z.email()).optional(),
  bcc: z.array(z.email()).optional(),
  subject: z.string().optional().describe("Left off a reply, it is derived from the message."),
  body: z
    .string()
    .describe("The message, as plain text. Markdown is not rendered by mail clients."),
  identityId: z
    .string()
    .optional()
    .describe(
      "Sender identity, as listed by mail_identities. Required when the account has several.",
    ),
  replyToEmailId: z
    .string()
    .optional()
    .describe("Message this answers, as returned by mail_search. Threads the reply onto it."),
  send: z
    .boolean()
    .optional()
    .describe(
      "Send the message instead of leaving it in drafts. Asks for confirmation first, and the " +
        "message ends up in the sent folder rather than in drafts.",
    ),
};

const inputSchema = z.object(composeInputShape).refine(
  (input) => input.to !== undefined || input.replyToEmailId !== undefined,
  // Without either, there is nobody to write to and no message to answer.
  { message: "Give `to`, or `replyToEmailId` to answer a message.", path: ["to"] },
);

type ComposeInput = z.infer<typeof inputSchema>;

export const mailCompose = defineTool({
  name: "mail_compose",
  title: "Compose a draft",
  description:
    "Writes a plain-text message into the drafts folder and returns its id. Nothing is sent " +
    "unless send is true, and sending is confirmed before it happens. " +
    "The sender is taken from the chosen identity, never from an address given here. " +
    "Pass replyToEmailId to answer a message: the reply is threaded onto it and the subject is " +
    "derived when none is given. Attachments are out of reach of this tool.",
  inputSchema,
  classes: ["draft", "send"],
  // One argument turns a draft into something that cannot be taken back, which
  // is exactly why the class is read off the arguments and not off the name.
  classify: (input) => (input.send === true ? "send" : "draft"),
  summarize: (input) => summarizeCompose(input),
  // Only the addresses the call states: a reply that names none is checked in
  // `run`, once the message it answers has been read.
  precheck: (input, { recipients }) =>
    outsidePerimeter([...(input.to ?? []), ...(input.cc ?? []), ...(input.bcc ?? [])], recipients),
  run: async (input, { client, session, recipients: scope }) => {
    const resolved = await resolveContext(input, client, session);
    if ("refusal" in resolved) return { text: resolved.refusal };

    const { identity, draftsId, sentId, source } = resolved;
    const create = buildDraft(input, identity, draftsId, source);
    const recipients = uniqueRecipients(create);

    // Checked again, on the addresses actually written: a reply resolves its
    // recipient from the server, and that one has never been through `precheck`.
    const outside = outsidePerimeter(recipients, scope);
    if (outside !== undefined) return { text: outside };

    const setArguments: EmailSetArguments = {
      accountId: session.accountId,
      create: { [DRAFT_CREATION_ID]: create },
    };

    // `sentId` is set exactly when the call sends: `resolveContext` refuses a
    // send it could not file, so its absence means the message stays a draft.
    if (sentId === undefined) {
      const response = await client.request<SetResponse<Email>>(
        [CAPABILITY_CORE, CAPABILITY_MAIL],
        ["Email/set", setArguments, "0"],
      );

      const failure = describeNotCreated(response);
      if (failure !== undefined) return { text: failure };

      const created = response.created?.[DRAFT_CREATION_ID];
      return {
        text: renderFields({
          draftId: created?.id ?? "(unknown)",
          from: identity.email,
          to: addressList(create.to),
          cc: addressList(create.cc),
          bcc: addressList(create.bcc),
          subject: create.subject,
          status: "saved to drafts, not sent",
        }),
      };
    }

    if (recipients.length === 0) {
      return { text: "Refused: this message has no recipient, so there is nobody to send it to." };
    }

    // Creation and submission travel together: the submission points at the
    // draft by creation id, so the message never exists unsent between two
    // round trips.
    const [written, submitted, moved] = await client.requestMany<
      [SetResponse<Email>, SetResponse<EmailSubmission>, SetResponse<Email> | undefined]
    >(
      [CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION],
      [
        ["Email/set", setArguments, "0"],
        [
          "EmailSubmission/set",
          buildSubmission({
            accountId: session.accountId,
            identityId: identity.id,
            mailFrom: identity.email,
            emailId: `#${DRAFT_CREATION_ID}`,
            recipients,
            draftsId,
            sentId,
          }),
          "1",
        ],
      ],
    );

    const failure = describeNotCreated(written);
    if (failure !== undefined) return { text: failure };

    return {
      text: describeSubmission(submitted, moved, {
        from: identity.email,
        recipients,
        subject: create.subject ?? "",
      }),
    };
  },
});

interface ComposeContext {
  identity: Identity;
  draftsId: Id;
  /** The sent folder, resolved only when the call sends. */
  sentId?: Id;
  /** The message being answered, when one was asked for and found. */
  source?: Email;
}

/**
 * Resolves the identity, the folders and the message being answered, in one
 * round trip, and refuses rather than choosing when the answer is ambiguous.
 * Nothing here writes: every refusal leaves the account untouched.
 */
export async function resolveContext(
  input: {
    identityId?: string | undefined;
    replyToEmailId?: string | undefined;
    send?: boolean | undefined;
  },
  client: {
    requestMany: <T extends unknown[]>(using: string[], calls: Invocation[]) => Promise<T>;
  },
  session: { accountId: Id },
): Promise<ComposeContext | { refusal: string }> {
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

  const calls: Invocation[] = [
    ["Identity/get", identityArguments, "0"],
    ["Mailbox/get", mailboxArguments, "1"],
  ];

  if (input.replyToEmailId !== undefined) {
    const sourceArguments: EmailGetArguments = {
      accountId: session.accountId,
      ids: [input.replyToEmailId],
      properties: REPLY_SOURCE_PROPERTIES,
    };
    calls.push(["Email/get", sourceArguments, "2"]);
  }

  const [identities, mailboxes, sources] = await client.requestMany<
    [GetResponse<Identity>, GetResponse<Mailbox>, GetResponse<Email> | undefined]
  >([CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION], calls);

  const identity = pickIdentity(identities.list, input.identityId);
  if ("refusal" in identity) return identity;

  const drafts = mailboxes.list.find((mailbox) => mailbox.role === "drafts");
  if (drafts === undefined) {
    return {
      refusal:
        "Refused: this account has no folder with the `drafts` role, so there is nowhere to save a " +
        "draft. Create one on the mail server, or give an existing folder that role.",
    };
  }

  const base: ComposeContext = { identity, draftsId: drafts.id };

  if (input.send === true) {
    const sent = mailboxes.list.find((mailbox) => mailbox.role === "sent");
    if (sent === undefined) return { refusal: MISSING_SENT_FOLDER };
    base.sentId = sent.id;
  }

  if (input.replyToEmailId === undefined) return base;

  const source = sources?.list[0];
  if (source === undefined) {
    return {
      refusal: `Refused: message ${input.replyToEmailId} is not in this account, so there is nothing to answer.`,
    };
  }

  return { ...base, source };
}

/**
 * The refusal the recipient perimeter raises, or `undefined` to go ahead.
 *
 * A list with no address passes: there is nobody to place inside or outside the
 * perimeter, and the missing recipient is refused on its own terms further on.
 */
export function outsidePerimeter(
  addresses: readonly string[],
  scope: RecipientScope,
): string | undefined {
  if (addresses.length === 0) return undefined;

  const verdict = checkRecipients(addresses, scope);
  return verdict.ok ? undefined : verdict.refusal;
}

/**
 * Refused before the submission, never after: a message sent with nowhere to
 * file it leaves the account with no trace of what went out.
 */
export const MISSING_SENT_FOLDER =
  "Refused: this account has no folder with the `sent` role, so a sent message would leave no " +
  "trace of having been sent. Create one on the mail server, or give an existing folder that role.";

/**
 * Picks the sender.
 *
 * With several identities and no designation, it refuses: sending as the wrong
 * address is the kind of mistake that cannot be taken back, and the account
 * owner is the only one who knows which of their addresses this message is from.
 */
export function pickIdentity(
  identities: Identity[],
  requested: string | undefined,
): Identity | { refusal: string } {
  if (requested !== undefined) {
    const found = identities.find((identity) => identity.id === requested);
    if (found === undefined) {
      return {
        refusal: `Refused: identity ${requested} is not one of this account's identities. Run mail_identities to list them.`,
      };
    }
    return found;
  }

  const [first, second] = identities;
  if (first === undefined) {
    return {
      refusal:
        "Refused: this account declares no sending identity, so a message has no address to come from.",
    };
  }
  if (second !== undefined) {
    return {
      refusal:
        `Refused: this account has ${identities.length} sending identities and none was designated. ` +
        "Pass identityId — run mail_identities to see them.",
    };
  }

  return first;
}

/**
 * Builds the creation payload.
 *
 * Neither `headers` nor any `header:*` property appears: RFC 8621 refuses both
 * at creation. `inReplyTo` and `references` are the convenience properties that
 * carry the threading instead.
 */
function buildDraft(
  input: ComposeInput,
  identity: Identity,
  draftsId: Id,
  source: Email | undefined,
): EmailCreate {
  const to = input.to ?? repliedTo(source);

  const draft: EmailCreate = {
    mailboxIds: { [draftsId]: true },
    keywords: { $draft: true },
    from: [{ name: identity.name === "" ? null : identity.name, email: identity.email }],
    to: to.map(toAddress),
    subject: subjectFor(input, source),
    bodyValues: { [BODY_PART_ID]: { value: input.body } },
    textBody: [{ partId: BODY_PART_ID, type: "text/plain" }],
  };

  if (input.cc !== undefined) draft.cc = input.cc.map(toAddress);
  if (input.bcc !== undefined) draft.bcc = input.bcc.map(toAddress);

  if (source !== undefined) {
    const originId = source.messageId?.[0];
    if (originId !== undefined) {
      draft.inReplyTo = [originId];
      // The origin's own chain, then the origin: that is the thread, in order.
      draft.references = [...(source.references ?? []), originId];
    }
  }

  return draft;
}

/** Reply-To wins over From: it is where the sender asked to be answered. */
function repliedTo(source: Email | undefined): string[] {
  const addresses = source?.replyTo ?? source?.from ?? [];
  return addresses.map((address) => address.email);
}

/** `Re:` once, whatever the casing the origin already carries. */
function subjectFor(input: ComposeInput, source: Email | undefined): string {
  if (input.subject !== undefined) return input.subject;
  if (source === undefined) return "";

  const origin = source.subject ?? "";
  return /^\s*re\s*:/i.test(origin) ? origin : `Re: ${origin}`;
}

function toAddress(email: string): EmailAddress {
  return { name: null, email };
}

function addressList(addresses: EmailAddress[] | undefined): string {
  return (addresses ?? []).map((address) => address.email).join(", ");
}

/** A `SetError` is the server's own words: quoting it beats guessing at it. */
export function describeNotCreated(
  response: SetResponse<unknown>,
  creationId: Id = DRAFT_CREATION_ID,
): string | undefined {
  const error = response.notCreated?.[creationId];
  if (error === undefined) return undefined;

  const meaning = explainSetError(error.type);
  const detail = error.description === undefined ? "" : ` — ${error.description}`;
  const properties =
    error.properties === undefined || error.properties.length === 0
      ? ""
      : ` (properties: ${error.properties.join(", ")})`;
  const gloss = meaning === undefined ? "" : `\n\nThat error means ${meaning}.`;

  return `Refused by the mail server: ${error.type}${detail}${properties}${gloss}`;
}

export function summarizeCompose(input: {
  to?: string[] | undefined;
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject?: string | undefined;
  replyToEmailId?: string | undefined;
  send?: boolean | undefined;
}): string {
  const recipients = [...(input.to ?? []), ...(input.cc ?? []), ...(input.bcc ?? [])];
  const who = recipients.length > 0 ? recipients.join(", ") : "the sender of the message answered";
  const what = input.subject === undefined ? "no subject yet" : `subject "${input.subject}"`;

  return input.send === true
    ? `Send a message to ${who}, ${what}. It leaves the account as soon as this is confirmed.`
    : `Save a draft to ${who}, ${what}.`;
}

/*
 * Submitting.
 *
 * The pieces below build and read an `EmailSubmission/set`. They live next to
 * the draft they send because `mail_compose` can do both in one request, and
 * `mail_send` reuses them on a draft written earlier.
 */

/** The creation id the submission is filed under, so a patch can point at it. */
export const SUBMISSION_CREATION_ID = "submission";

/**
 * Who the message is actually delivered to, in order and without repeats.
 *
 * A recipient named twice, in `to` and in `cc`, is one delivery. Addresses are
 * compared verbatim: the local part is case-sensitive per RFC 5321, so folding
 * it here would merge two mailboxes that the server tells apart.
 */
export function uniqueRecipients(message: {
  to?: EmailAddress[] | null;
  cc?: EmailAddress[] | null;
  bcc?: EmailAddress[] | null;
}): string[] {
  const addresses = [...(message.to ?? []), ...(message.cc ?? []), ...(message.bcc ?? [])];
  return [...new Set(addresses.map((address) => address.email))];
}

/**
 * Builds the submission and the move that follows it.
 *
 * The envelope is stated rather than derived: letting the server read the
 * headers means not knowing who receives the message. `onSuccessDestroyEmail`
 * is never emitted — the copy left in the sent folder is the only record of
 * what went out.
 */
export function buildSubmission(input: {
  accountId: Id;
  identityId: Id;
  mailFrom: string;
  /** The draft's id, or `#<creationId>` when it is created in the same request. */
  emailId: Id;
  recipients: string[];
  draftsId: Id;
  sentId: Id;
}): EmailSubmissionSetArguments {
  const envelope: Envelope = {
    mailFrom: { email: input.mailFrom },
    rcptTo: input.recipients.map((email) => ({ email })),
  };

  return {
    accountId: input.accountId,
    create: {
      [SUBMISSION_CREATION_ID]: {
        identityId: input.identityId,
        emailId: input.emailId,
        envelope,
      },
    },
    // Neither `sendAt` nor `undoStatus`: RFC 8621 reserves both to the server.
    onSuccessUpdateEmail: {
      [`#${SUBMISSION_CREATION_ID}`]: {
        [`mailboxIds/${input.draftsId}`]: null,
        [`mailboxIds/${input.sentId}`]: true,
        "keywords/$draft": null,
      },
    },
  };
}

/**
 * Reads the outcome of a submission.
 *
 * A move the server declined is reported rather than assumed away: the message
 * did leave, and a caller told otherwise would send it a second time.
 */
export function describeSubmission(
  submitted: SetResponse<EmailSubmission>,
  moved: SetResponse<Email> | undefined,
  details: { from: string; recipients: string[]; subject: string },
): string {
  const failure = describeNotCreated(submitted, SUBMISSION_CREATION_ID);
  if (failure !== undefined) return failure;

  const created = submitted.created?.[SUBMISSION_CREATION_ID];
  const [moveError] = Object.values(moved?.notUpdated ?? {});

  return renderFields({
    submissionId: created?.id ?? "(unknown)",
    emailId: created?.emailId ?? "",
    from: details.from,
    to: details.recipients.join(", "),
    subject: details.subject,
    status:
      moveError === undefined
        ? "sent, and moved to the sent folder"
        : `sent, but it could not be moved out of drafts: ${moveError.type}`,
  });
}
