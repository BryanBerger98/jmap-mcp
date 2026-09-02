import { z } from "zod";
import type { GetResponse, Id, Invocation, SetResponse } from "../../jmap/types/core.js";
import { CAPABILITY_CORE, CAPABILITY_MAIL, CAPABILITY_SUBMISSION } from "../../jmap/types/core.js";
import type {
  Email,
  EmailAddress,
  EmailCreate,
  EmailGetArguments,
  EmailSetArguments,
  EmailSubmission,
  Identity,
  IdentityGetArguments,
  Mailbox,
  MailboxGetArguments,
} from "../../jmap/types/mail.js";
import { defineTool, type ToolContext } from "../../registry/define-tool.js";
import { renderFields } from "../../shared/render.js";
import { describeHtmlBody } from "./html.js";
import {
  buildSubmission,
  DRAFT_CREATION_ID,
  describeNotCreated,
  describeSubmission,
  IDENTITY_PROPERTIES,
  MAILBOX_PROPERTIES,
  MISSING_SENT_FOLDER,
  outsidePerimeter,
  pickIdentity,
  uniqueRecipients,
} from "./submission.js";

/** The plain-text body part. */
const BODY_PART_ID = "body";

/**
 * The HTML body part.
 *
 * Distinct from the text one because `bodyValues` is a map: two bodies are two
 * entries, and one key could only hold one of them.
 */
const HTML_PART_ID = "html";

/** Only what the threading and the fallback recipient need off the origin. */
const REPLY_SOURCE_PROPERTIES = ["id", "messageId", "references", "subject", "from", "replyTo"];

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
    .optional()
    .describe(
      "The message, as plain text. Markdown is not rendered by mail clients. " +
        "Give this, htmlBody, or both.",
    ),
  htmlBody: z
    .string()
    .optional()
    .describe(
      "The message, as HTML. It is sent exactly as given: nothing is stripped, escaped or " +
        "rewritten, and no plain-text version is derived from it. Giving body as well is " +
        "worth it for clients that only display text, but it is not required.",
    ),
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

const inputSchema = z
  .object(composeInputShape)
  .refine(
    (input) => input.to !== undefined || input.replyToEmailId !== undefined,
    // Without either, there is nobody to write to and no message to answer.
    { message: "Give `to`, or `replyToEmailId` to answer a message.", path: ["to"] },
  )
  .refine(
    (input) => input.body !== undefined || input.htmlBody !== undefined,
    // The server's own guard against an empty message counts headers as content
    // — `email/set.rs:728-740` — and a draft always carries `from`, `to` and
    // `subject`. So it would accept this one, and the recipient would get a
    // message with nothing in it.
    {
      message: "Give `body`, `htmlBody`, or both: a message with no body at all is not written.",
      path: ["body"],
    },
  );

type ComposeInput = z.infer<typeof inputSchema>;

export const mailCompose = defineTool({
  name: "mail_compose",
  title: "Compose a draft",
  description:
    "Writes a message into the drafts folder and returns its id. The body can be plain text, " +
    "HTML, or both, and at least one of the two is required. Nothing is sent " +
    "unless send is true, and sending is confirmed before it happens. " +
    "The sender is taken from the chosen identity, never from an address given here. " +
    "Pass replyToEmailId to answer a message: the reply is threaded onto it and the subject is " +
    "derived when none is given. Attachments are out of reach of this tool.",
  inputSchema,
  classes: ["draft", "send"],
  // One argument turns a draft into something that cannot be taken back, which
  // is exactly why the class is read off the arguments and not off the name.
  classify: (input) => (input.send === true ? "send" : "draft"),
  // A reply carries its recipient in the message it answers, and confirming
  // "the sender of the message answered" names nobody. The address is read back
  // so the line the user is shown says who this actually leaves for.
  summarize: async (input, context) =>
    summarizeCompose(input, await namedRecipients(input, context)),
  precheck: async (input, context) => {
    const stated = [...(input.to ?? []), ...(input.cc ?? []), ...(input.bcc ?? [])];

    // Settled on the arguments alone whenever they suffice: a refusal that costs
    // no round trip must not start paying for one.
    const refusal = outsidePerimeter(stated, context.recipients);
    if (refusal !== undefined) return refusal;

    // A reply that names nobody still has a recipient, and it is in the message
    // it answers. Left unread, the perimeter would be met for the first time in
    // `run` — after the user had been asked to confirm a doomed send.
    if (context.recipients.kind === "anyone") return undefined;
    if (input.to !== undefined || input.replyToEmailId === undefined) return undefined;

    const replied = await repliedRecipients(input, context);
    return replied === undefined ? undefined : outsidePerimeter(replied, context.recipients);
  },
  run: async (input, context) => {
    const { client, session, recipients: scope } = context;
    const resolved = await composeContext(input, context);
    if ("refusal" in resolved) return { text: resolved.refusal };

    const { identity, draftsId, sentId, source } = resolved;
    const create = buildDraft(input, identity, draftsId, source);
    const recipients = uniqueRecipients(create);

    // Checked again, on the addresses actually written. `precheck` reads the
    // same message, but it swallows a failed read to avoid refusing on a
    // transport error — so the last word on who this reaches belongs here.
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
    properties: [...IDENTITY_PROPERTIES],
  };
  const mailboxArguments: MailboxGetArguments = {
    accountId: session.accountId,
    ids: null,
    properties: [...MAILBOX_PROPERTIES],
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
 * Builds the creation payload.
 *
 * Neither `headers` nor any `header:*` property appears: RFC 8621 refuses both
 * at creation. `inReplyTo` and `references` are the convenience properties that
 * carry the threading instead.
 *
 * `bodyStructure` and `attachments` are absent for a second reason, and it is
 * not the same one: the server reads the body properties only when neither is
 * given — `email/set.rs:128-129` — so writing either would silently drop the
 * bodies below.
 *
 * The body values are the arguments as received. Nothing renders, truncates or
 * escapes them on the way through: what the caller wrote is what leaves.
 */
function buildDraft(
  input: ComposeInput,
  identity: Identity,
  draftsId: Id,
  source: Email | undefined,
): EmailCreate {
  const to = input.to ?? repliedTo(source);

  const bodyValues: Record<string, { value: string }> = {};
  if (input.body !== undefined) bodyValues[BODY_PART_ID] = { value: input.body };
  if (input.htmlBody !== undefined) bodyValues[HTML_PART_ID] = { value: input.htmlBody };

  const draft: EmailCreate = {
    mailboxIds: { [draftsId]: true },
    keywords: { $draft: true },
    from: [{ name: identity.name === "" ? null : identity.name, email: identity.email }],
    to: to.map(toAddress),
    subject: subjectFor(input, source),
    bodyValues,
  };

  // An absent part is an absent property, never an empty list: the server reads
  // "one part at most", and a list with no element is not the same statement.
  if (input.body !== undefined) {
    draft.textBody = [{ partId: BODY_PART_ID, type: "text/plain" }];
  }
  if (input.htmlBody !== undefined) {
    draft.htmlBody = [{ partId: HTML_PART_ID, type: "text/html" }];
  }

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

/**
 * The addresses this call will write to, as far as they can be known before
 * anything is written.
 *
 * A reply with no `to` takes its recipient from the message it answers, so that
 * message is read back rather than guessed at. An empty list means it could not
 * be read: the caller says so rather than naming an address it is unsure of.
 */
async function namedRecipients(input: ComposeInput, context: ToolContext): Promise<string[]> {
  const stated = [...(input.to ?? []), ...(input.cc ?? []), ...(input.bcc ?? [])];
  if (input.to !== undefined || input.replyToEmailId === undefined) return stated;

  const replied = await repliedRecipients(input, context);
  return replied === undefined ? stated : [...replied, ...stated];
}

/**
 * Who a reply would go to, or `undefined` when the origin could not be read.
 *
 * Every failure is swallowed: this runs before the call is confirmed, and a
 * transport error here must not be reported as a refusal `run` never raised.
 */
async function repliedRecipients(
  input: ComposeInput,
  context: ToolContext,
): Promise<string[] | undefined> {
  const resolved = await composeContext(input, context).catch(() => undefined);
  if (resolved === undefined || "refusal" in resolved) return undefined;

  return repliedTo(resolved.source);
}

/**
 * The resolution, read once per handler invocation.
 *
 * `summarize`, `precheck` and `run` all answer the same call, so they read the
 * same message. The key names the arguments the resolution depends on.
 */
function composeContext(
  input: ComposeInput,
  context: ToolContext,
): Promise<ComposeContext | { refusal: string }> {
  const key = `mail_compose:${input.replyToEmailId ?? ""}:${input.identityId ?? ""}:${input.send === true}`;
  return context.once(key, () => resolveContext(input, context.client, context.session));
}

export function summarizeCompose(
  input: {
    to?: string[] | undefined;
    cc?: string[] | undefined;
    bcc?: string[] | undefined;
    subject?: string | undefined;
    body?: string | undefined;
    htmlBody?: string | undefined;
    replyToEmailId?: string | undefined;
    send?: boolean | undefined;
  },
  recipients: readonly string[],
): string {
  const who = recipients.length > 0 ? recipients.join(", ") : "the sender of the message answered";
  const what = input.subject === undefined ? "no subject yet" : `subject "${input.subject}"`;

  const opening =
    input.send === true
      ? `Send a message to ${who}, ${what}. It leaves the account as soon as this is confirmed.`
      : `Save a draft to ${who}, ${what}.`;

  return [opening, ...bodyLines(input.body, input.htmlBody)].join("\n\n");
}

/**
 * What the body is made of, said before it leaves.
 *
 * Three statements rather than two, because "HTML" alone does not tell the one
 * thing the user arbitrates on: whether a client that only shows text has
 * anything left to show. Nothing filters the markup, so this and the excerpt
 * below it are the whole of what stands between a generated body and a signed
 * message.
 */
function bodyLines(body: string | undefined, htmlBody: string | undefined): string[] {
  if (htmlBody === undefined) return ["The body is plain text."];

  const format =
    body === undefined
      ? "The body is HTML, with no plain-text part beside it: a client that only displays text " +
        "will show little or nothing of it."
      : "The body is HTML, with a plain-text part beside it.";

  return [format, describeHtmlBody(htmlBody)];
}
